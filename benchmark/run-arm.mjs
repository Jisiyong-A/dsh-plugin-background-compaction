// Run one compaction-benchmark arm end to end and record its metrics.
//
// Each arm swaps ONLY the compaction stack in the profile patch, then replays the
// exact same task: read 16 fixed-size documents in order, then report three exact
// constants from the FIRST document. Two things are measured:
//
//   latency  — how long the agent turn is blocked inside `compaction/start .. end`
//   fidelity — whether the constants from the oldest, most-compacted document
//              survive whatever compaction strategy ran
//
// Usage:
//   node benchmark/run-arm.mjs a            # one arm
//   node benchmark/run-arm.mjs a b c d      # several arms, sequentially
//   node benchmark/run-arm.mjs --task-only  # print the shared task prompt

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, readRecords, report } from './measure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FIXTURES = join(HERE, 'fixtures')
const RESULTS = join(HERE, 'results')
const ARMS_DIR = join(HERE, 'arms')

const DSH = 'C:\\Users\\siuchau_chi\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const PROFILE = 'bc-headless'
const PROFILE_PATCH = `C:\\Users\\siuchau_chi\\.dsh\\profiles\\${PROFILE}\\cordis.patch.yml`
const SESSIONS_ROOT = 'C:\\Users\\siuchau_chi\\.dsh\\sessions'
const PROXY = 'http://127.0.0.1:7897'

export const TASK = [
  '严格按以下要求执行，不要偏离：',
  '1) 依次读取当前目录下的 doc-01.md、doc-02.md …… 一直到 doc-16.md，每次只调用一次 read 工具读取一个文件，严格按编号顺序推进，禁止并行读取；',
  '2) 在 16 个文件全部读完之前，不要输出任何分析、总结、解释或前言文字；',
  '3) 16 个文件全部读完后，一次性回答 doc-01.md 中 Recorded constants 的三项值，逐项列出 SERVICE_TOKEN_01、LISTEN_PORT_01、RETENTION_DAYS_01 的准确值。',
].join('')

/**
 * Run a shell command string.
 *
 * `spawnSync(file, args, { shell: true })` does NOT quote `file`, so the harness
 * path (which contains spaces) is shredded by cmd.exe. Everything therefore goes
 * through a single pre-quoted command string.
 */
function shellRun(command, { cwd, timeout = 5 * 60 * 1000, env } = {}) {
  return spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    cwd,
    env: env ?? process.env,
  })
}

const ARM_FILES = {
  a: 'a-basic.yml',
  b: 'b-pruner.yml',
  c: 'c-dcp.yml',
  d: 'd-background.yml',
}

// Packages installed ONLY for the duration of an arm's run.
//
// `dsh plugin add` puts the package into `dsh.profile.bundles`, which makes its
// OWN bundled patch apply on every load. Both candidate backends replace
// `ctx.compaction`, so if both are installed at once the service cannot mount and
// NO compaction happens at all - silently, with no error in the run. Every arm
// therefore starts from a profile with neither backend installed.
//
// `add` accepts a version or a local path; `remove` needs the bare npm name.
// `entry` is the LOADER ENTRY ID that shows up in `--dump-config` - it is not the
// npm package name, and the isolation gate has to compare against it.
const BACKENDS = [
  { add: '@aiwayds/dsh-dcp@0.13.1', remove: '@aiwayds/dsh-dcp', entry: 'dsh-dcp' },
  { add: ROOT, remove: 'dsh-plugin-background-compaction', entry: 'background-compaction' },
]

const ARM_PACKAGES = {
  a: [],
  b: [],
  c: ['@aiwayds/dsh-dcp@0.13.1'],
  d: [ROOT],
}

const ARM_LABELS = {
  a: 'A - compaction-basic (foreground LLM)',
  b: 'B - tool-result-pruner + compaction-basic',
  c: 'C - dsh-dcp (deterministic, zero LLM)',
  d: 'D - background-compaction (this plugin)',
}

function pluginCli(args) {
  const command = `"${DSH}" plugin --profile ${PROFILE} ${args.map((a) => `"${a}"`).join(' ')}`
  const result = shellRun(command, {
    timeout: 5 * 60 * 1000,
    env: { ...process.env, HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY },
  })
  if (result.status !== 0) {
    console.log(`[plugin ${args.join(' ')}] exit ${result.status}`)
    console.log((result.stdout ?? '').slice(-1500))
    console.log((result.stderr ?? '').slice(-1500))
  }
  return result.status === 0
}

function installArmPackages(arm) {
  for (const pkg of ARM_PACKAGES[arm]) {
    console.log(`[plugin] add ${pkg}`)
    pluginCli(['add', pkg])
  }
}

function uninstallArmPackages(arm) {
  for (const pkg of ARM_PACKAGES[arm]) {
    const bare = BACKENDS.find((b) => b.add === pkg)?.remove ?? pkg
    console.log(`[plugin] remove ${bare}`)
    pluginCli(['remove', bare])
  }
}

/** Remove BOTH candidate backends so no arm inherits the previous arm's bundle. */
function resetProfileBackends() {
  for (const backend of BACKENDS) {
    const ok = pluginCli(['remove', backend.remove])
    if (!ok) console.log(`[plugin] ${backend.remove} was not installed (fine)`)
  }
}

/** Which replacement compaction backends the composed profile would mount. */
function mountedBackends() {
  const dump = shellRun(`"${DSH}" --profile ${PROFILE} --dump-config`, { timeout: 120_000 })
  const lines = (dump.stdout ?? '').split(/\r?\n/)
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].trimEnd().match(/^-\s+id:\s+(dsh-dcp|background-compaction)$/)
    if (!m) continue
    let disabled = false
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (/^\s+disabled:\s*true/.test(lines[j])) disabled = true
      if (/^\s*-?\s*id:/.test(lines[j])) break
    }
    if (!disabled) found.push(m[1])
  }
  return found
}

function composePatch(arm) {
  const base = readFileSync(join(ARMS_DIR, '_base.yml'), 'utf8')
  const overlay = readFileSync(join(ARMS_DIR, ARM_FILES[arm]), 'utf8')
  return [
    `# GENERATED by benchmark/run-arm.mjs - arm ${arm} (${ARM_LABELS[arm]})`,
    `# Task: read doc-01..doc-16 in order, then report doc-01 constants.`,
    '',
    base,
    '',
    overlay,
  ].join('\n')
}

function listSessionDirs() {
  const out = new Set()
  if (!existsSync(SESSIONS_ROOT)) return out
  for (const workspaceDir of readdirSync(SESSIONS_ROOT)) {
    const workspacePath = join(SESSIONS_ROOT, workspaceDir)
    let entries
    try {
      entries = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      out.add(join(workspacePath, entry.name))
    }
  }
  return out
}

function newestSessionLog(before) {
  const candidates = []
  for (const dir of listSessionDirs()) {
    if (before.has(dir)) continue
    const log = join(dir, 'session.v4.jsonl.zstd')
    if (!existsSync(log)) continue
    candidates.push({ dir, log, mtime: statSync(log).mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]
}

/** Pull the final assistant text so fidelity can be checked against the fixtures. */
function finalAnswer(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record.type !== 'assistant/message') continue
    const content = record.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function checkFidelity(answer, expected) {
  const results = expected.map((constant) => {
    const value = constant.split(':').slice(1).join(':').trim()
    return { constant, value, survived: value.length > 0 && answer.includes(value) }
  })
  return {
    survived: results.filter((r) => r.survived).length,
    total: results.length,
    results,
  }
}

function runArm(arm, rep) {
  const label = ARM_LABELS[arm]
  const suffix = rep ? `${arm}-r${rep}` : arm
  console.log(`\n===== arm ${arm}${rep ? ` rep ${rep}` : ''}: ${label} =====`)

  resetProfileBackends()
  installArmPackages(arm)
  writeFileSync(PROFILE_PATCH, composePatch(arm), 'utf8')
  console.log(`[patch] wrote ${PROFILE_PATCH}`)

  try {
    // Isolation gate: prove the composed config mounts exactly the backends this
    // arm expects. A silent double-mount produces a run with zero compaction and
    // no error, which would be indistinguishable from "the strategy did nothing".
    const expected = BACKENDS.filter((b) => ARM_PACKAGES[arm].includes(b.add)).map((b) => b.entry)
    const mounted = mountedBackends()
    const ok = mounted.length === expected.length && expected.every((name) => mounted.includes(name))
    console.log(`[isolation] expected [${expected.join(', ') || 'stock'}] mounted [${mounted.join(', ') || 'stock'}]`)
    if (!ok) {
      console.log(`[FAIL] arm ${arm} isolation is wrong - refusing to record a misleading result`)
      writeFileSync(
        join(RESULTS, `${suffix}.json`),
        JSON.stringify({ arm, label, failed: true, reason: 'isolation', expected, mounted }, null, 2),
      )
      return
    }

    const before = listSessionDirs()
    const startedAt = Date.now()
    const command = `"${DSH}" --profile ${PROFILE} "${TASK}"`
    const result = shellRun(command, {
      cwd: FIXTURES,
      timeout: 20 * 60 * 1000,
      env: { ...process.env, HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, DBG_BGC: arm === 'd' ? '1' : '' },
    })
    const elapsedMs = Date.now() - startedAt

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    writeFileSync(join(RESULTS, `${suffix}.stdout.log`), stdout, 'utf8')
    writeFileSync(join(RESULTS, `${suffix}.stderr.log`), stderr, 'utf8')

    const found = newestSessionLog(before)
    if (!found) {
      console.log(`[FAIL] no new session log for arm ${arm}; exit=${result.status}`)
      writeFileSync(
        join(RESULTS, `${suffix}.json`),
        JSON.stringify({ arm, label, failed: true, exitCode: result.status, elapsedMs }, null, 2),
      )
      return
    }

    const records = readRecords(found.log)
    const metrics = measure(records)
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
    const expectedConstants = manifest[0].constants
    const answer = finalAnswer(records)
    const fidelity = checkFidelity(answer, expectedConstants)

    const payload = {
      arm,
      rep: rep ?? 1,
      label,
      session: found.dir.split('\\').pop(),
      log: found.log,
      exitCode: result.status,
      elapsedMs,
      metrics,
      fidelity,
      expectedConstants,
      finalAnswer: answer,
    }
    writeFileSync(join(RESULTS, `${suffix}.json`), JSON.stringify(payload, null, 2), 'utf8')

    console.log(report(metrics))
    console.log(`fidelity: ${fidelity.survived}/${fidelity.total} doc-01 constants survived`)
    for (const r of fidelity.results) console.log(`  ${r.survived ? 'OK  ' : 'LOST'} ${r.constant}`)
    console.log(`wall clock (process): ${(elapsedMs / 1000).toFixed(1)}s`)
    console.log(`session: ${payload.session}`)
  } finally {
    uninstallArmPackages(arm)
  }
}

const args = process.argv.slice(2)
if (args.includes('--task-only')) {
  console.log(TASK)
  process.exit(0)
}
mkdirSync(RESULTS, { recursive: true })

// `--rep N` keeps repeated runs side by side instead of overwriting, so a single
// arm can be sampled several times and reported as a distribution.
const repIndex = args.indexOf('--rep')
const rep = repIndex === -1 ? undefined : Number(args[repIndex + 1])
if (repIndex !== -1) args.splice(repIndex, 2)

const arms = args.length ? args : ['a', 'b', 'c', 'd']
for (const arm of arms) {
  if (!ARM_FILES[arm]) {
    console.error(`unknown arm "${arm}" (expected one of ${Object.keys(ARM_FILES).join(', ')})`)
    process.exit(2)
  }
  runArm(arm, rep)
}
console.log('\nall requested arms finished')
