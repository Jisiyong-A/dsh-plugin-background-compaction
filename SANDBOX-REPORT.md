# 沙盒可用性报告

**日期：** 2026-11-01
**问题：** 在真实的 DeepSeek Harness 运行时里，`dsh-plugin-background-compaction` 到底能不能压缩？按模型策略（`modelPolicies`）、零 headroom（`headroomTokens: 0` + 显式 `maxTokens`）、持有点交接与回退链路是否全部对齐基类？
**结论：** 能。插件以 `ctx.compaction` 的身份挂载，与 `BasicCompactionEngine` 共享同一套阈值与模型策略推导，在 `0.72 × threshold` 水位线处后台生成摘要并持有，到达阈值时先执行可选 `toolResultPruner` 并校验跨度与指纹，命中即零前台模型延迟提交 `compaction/summary` 事务；单步跨阈或漂移时无缝回退单次基类前台压缩，会话卸载时通过 Cordis `ctx.effect` 干净取消在途任务。

> 本文件记录 v2（代码审查加固后）的真实运行验证。v1（“摘要后替换消息数组”）架构已被废弃，
> 旧版报告中“`selectCompactableRange` 等辅助函数是公开 API”的说法是**错误的**——它们在
> `dsh-compaction-basic` 内部为模块私有。v2 走的是官方扩展面：继承 `BasicCompactionEngine`
> 并覆写 `summarize()` / `compactIfNeeded()` / `compactNow()`。

---

## 1. 沙盒搭建

沙盒禁用除本插件以外的一切压缩/裁剪机制，并刻意将顶层 `thresholdRatio` 设为 `0.9`（54000），仅在
`modelPolicies` 中为 `gemini / gemini-3.8-flash-high` 配置 `thresholdRatio: 0.6` 与
`headroomTokens: 0`（配对 `maxTokens: 4096`）。这样只有当 `modelPolicies` 顶层 `provider/model`
匹配与 `headroomTokens: 0` 透传同时生效时，阈值才会落在 `36000`、水位线落在 `25920`。

| 项目 | 设置 |
| --- | --- |
| profile | `bc-headless`（`dsh --profile bc-headless "<task>"`） |
| 插件安装 | `dsh plugin --profile bc-headless add <包路径>`，pnpm 建立 junction |
| 禁用 | `compaction-basic`、`command-compact`、`tool-result-pruner` |
| 启用 | `credentials`（headless 模板默认禁用，否则 `MISSING_CREDENTIAL`） |
| 模型 | gemini / `gemini-3.8-flash-high`，`contextWindow: 60000`、`maxTokens: 4096` |
| 插件顶层配置 | `thresholdRatio: 0.9`、`maxTokens: 4096`、`auto: true` |
| `modelPolicies[0]` | `provider: gemini`、`model: gemini-3.8-flash-high`、`thresholdRatio: 0.6`、`headroomTokens: 0`、`retainRatio: 0.1`、`maxTokens: 4096` |
| 后台投机配置 | `enabled: true`、`precomputeAtRatio: 0.72`、`minShadowTokens: 500`、`debounceMs: 300`、`gateWindow: 6`、`gateMinHitRate: 0.5`、`gateCooldownMs: 300000`、`trace: true` |

阈值推导：`messageBudget = 60000 - 4096 = 55904`，`pressureBudget = 55904 - 0 = 55904`，
`threshold = min(60000 × 0.6, 55904) = 36000`，水位线 `36000 × 0.72 = 25920`。

## 2. 实测证据

真实 `dsh --profile bc-headless` 运行（session `3f08caaf-8445-4927-9877-ed29333a4419`，`DBG_BGC=1`，退出码 0）：

```text
[bgc] engine mounted auto=true enabled=true speculating=true
[bgc] skip session=session-3f08caaf-...: no routed target header=null
[bgc] below watermark session=session-3f08caaf-... tokens=19199 watermark=25920 threshold=36000
[bgc] below watermark session=session-3f08caaf-... tokens=21054 watermark=25920 threshold=36000
[bgc] below watermark session=session-3f08caaf-... tokens=24723 watermark=25920 threshold=36000
[bgc] skip session=session-3f08caaf-...: span too small (215t)
[bgc] precompute start session=session-3f08caaf-... span=8..17 tokens=10583
[bgc] precompute ready session=session-3f08caaf-... held=1
[bgc] compactIfNeeded trigger=pressure tokens=31041 threshold=36000 held=1 session=session-3f08caaf-...
[bgc] compactIfNeeded trigger=pressure tokens=33472 threshold=36000 held=1 session=session-3f08caaf-...
[bgc] compactIfNeeded trigger=pressure tokens=40726 threshold=36000 held=1 session=session-3f08caaf-...
[bgc] served held summary session=session-3f08caaf-... saved~10583t
[bgc] skip session=session-3f08caaf-...: already at pressure, foreground owns it
[bgc] precompute start session=session-3f08caaf-... span=69..69 tokens=915
[bgc] precompute cancelled session=session-3f08caaf-...
```

同一会话的持久化日志（`scripts/inspect-session.mjs` 解析，35 个 zstd 帧 / 78 条记录）：

| 位置 | 记录 | 含义 |
| --- | --- | --- |
| 55–58 | `compaction/start` → `compaction/summary`（4289 B）→ `user/message`（2525 B）→ `compaction/end` | **后台持有摘要零延迟提交**（折叠 `span=8..17`，约 10583 tokens） |
| 63 | `usage.totalTokens = 42516` | headless 重注入 117 KB 提示包并继续读大文件后，单步再次跨过阈值 |
| 67–70 | `compaction/start` → `compaction/summary`（8988 B）→ `user/message`（4000 B）→ `compaction/end` | 单步跨阈时无缝回退基类前台压缩，无中止事务 |
| 74 | `usage.totalTokens = 29035` | 第二次压缩后**服务端实测 token 从 42516 降至 29035（净降 13481 tokens）** |

全链路同时验证了：
1. `modelPolicies` 顶层 `{ provider, model }` 覆盖与 `headroomTokens: 0` 透传生效（阈值精准落在 `36000` 而非 `54000`）；
2. 持有摘要期间未达阈值（`31041`、`33472`）正常委派给基类，不阻断基类判断；
3. 达阈值（`40726`）时前置指纹校验通过，零前台模型调用提交持有摘要；
4. 会话结束卸载 Cordis fiber 时，`ctx.effect` 清理回调干净中止在途后台任务，正常退出（`ExitCode=0`）。

## 3. 关键发现

**3.1 触发窗口必须宽于单步增量。** 如果单步直接跨过阈值（如记录 63–65 一次读取 46 KB 文件），预计算窗口被跳过，插件自动退化为单次基类前台压缩（fail-open）。

**3.2 系统提示词本身占 ~19k–21k token。** 首次请求后固定头部即占约 19k–21k tokens，且 `system/message` 头部永不参与折叠，因此声明的 `contextWindow` 必须显著大于固定头部加保留尾部。

**3.3 headless 会重注入提示包。** 首次折叠后 headless runner 重新追加了 `user/message`（1618 B + 116974 B，记录 60–61），这是 headless 单发模式的行为，交互式会话不会发生；第二次折叠后（记录 67–70）服务端 `totalTokens` 直接从 `42516` 降至 `29035`。

**3.4 基类的摘要输出上限要留足。** `maxTokens: 512/2048` 时基类摘要器易触发 `summarization truncated at the token cap (incomplete checkpoint)`；设为 `4096` 后两次事务均完整闭合。

**3.5 `headroomTokens: 0` 的真实契约。** 基类 `resolveConfig` 允许 `headroomTokens: 0`（非负整数），但默认令 `maxTokens = config.maxTokens ?? headroomTokens` 并要求 `maxTokens` 为正整数。因此 `headroomTokens: 0` 只需配对显式正整数 `maxTokens` 即可合法运行；`pickBaseConfig()` 现已原样透传 `headroomTokens: 0`，不再静默丢弃回退到 `65536`。

## 4. 已知限制

- `ctx.compaction` 单实例：本插件**替换** `compaction-basic`，不能与之共存。
- 已经在压力之上时不启动后台预计算：直接由前台接管，并自动取消该会话在途的后台预计算。
- 滑窗命中率熔断：最近 `gateWindow`（默认 6）次投机结算命中率低于 `gateMinHitRate`（默认 0.5）时暂停投机 `gateCooldownMs`（默认 5 分钟），防止高漂移场景持续浪费后台调用。

## 5. 复现

```powershell
# 1) 检查组合后的 profile 配置
dsh --profile bc-headless --dump-config

# 2) 运行顺序文件阅读任务并采集 [bgc] 追踪
$env:DBG_BGC = '1'
dsh --profile bc-headless "按顺序逐个阅读 src/engine 下的 7 个文件以及 tests/engine.test.ts（每次严格只调用一次 read 读 1 个文件），每读完一个文件先输出 250 字要点再读下一个。"

# 3) 解析会话持久化日志
node scripts/inspect-session.mjs <session.v4.jsonl.zstd>
```
