/**
 * Contract-faithful, independent test double for `@deepseek-ai/dsh-compaction-basic`
 * (0.2.1-rc.5, verified against `app.asar/dsh/node_modules/@deepseek-ai/dsh-compaction-basic`).
 *
 * Deliberately imports NOTHING from `../../src/` so unit tests verify real parity
 * between the plugin and the base engine rather than testing the plugin against itself:
 * - strict `BASIC_COMPACT_CONFIG_KEYS` and `MODEL_POLICY_KEYS` validation
 * - real stock defaults (`headroomTokens: 65536`, `retainRatio: 0.16`, `maxTokens ?? headroomTokens`)
 * - `modelPolicies` matching via top-level `policy.provider` + `policy.model` (no `.target`)
 * - optional `toolResultPruner` execution before compaction
 * - `estimateMessage` shrink check (`framedSummaryTokens < shadowedTokens`)
 * - NO `dispose()` method (matching Cordis `Service` / `CompactionEngine`)
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'

/** One recorded base-class invocation, for assertions. */
export interface RecordedCall {
  method: string
  detail: unknown
}

const POLICY_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
] as const

const BASIC_COMPACT_CONFIG_KEYS = new Set<string>([...POLICY_KEYS, 'modelPolicies', 'auto'])
const MODEL_POLICY_KEYS = new Set<string>(['provider', 'model', ...POLICY_KEYS])

function validateKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}: unknown key "${key}"`)
  }
}

/** Independent reproduction of `resolveConfig` from `dsh-compaction-basic/lib/index.js:59-88`. */
function resolveBaseConfig(raw: Record<string, unknown> = {}) {
  validateKeys(raw, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  const headroomTokens = (raw.headroomTokens as number | undefined) ?? 65536
  if (!Number.isInteger(headroomTokens) || headroomTokens < 0) {
    throw new RangeError(`BasicCompactionConfig.headroomTokens (${String(headroomTokens)}) must be >= 0`)
  }
  const maxTokens = (raw.maxTokens as number | undefined) ?? headroomTokens
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError(
      `BasicCompactionConfig.maxTokens (explicit or from headroomTokens) (${String(maxTokens)}) must be a positive integer`,
    )
  }
  const rawPolicies = (raw.modelPolicies as Array<Record<string, unknown>> | undefined) ?? []
  const modelPolicies = rawPolicies.map((item, idx) => {
    validateKeys(item, MODEL_POLICY_KEYS, `BasicCompactionConfig.modelPolicies[${idx}]`)
    if (typeof item.provider !== 'string' || item.provider.length === 0) {
      throw new TypeError(`BasicCompactionConfig.modelPolicies[${idx}].provider must be non-empty`)
    }
    if (typeof item.model !== 'string' || item.model.length === 0) {
      throw new TypeError(`BasicCompactionConfig.modelPolicies[${idx}].model must be non-empty`)
    }
    return Object.freeze({ ...item })
  })
  const retention =
    raw.retainTokens !== undefined && raw.retainTokens !== null
      ? { retainTokens: raw.retainTokens as number }
      : { retainRatio: (raw.retainRatio as number | undefined) ?? 0.16 }

  return Object.freeze({
    thresholdRatio: (raw.thresholdRatio as number | undefined) ?? 0.8,
    headroomTokens,
    ...retention,
    summarizationProvider: (raw.summarizationProvider as string | undefined) ?? '',
    summarizationModel: (raw.summarizationModel as string | undefined) ?? '',
    maxTokens,
    compactionRetries: (raw.compactionRetries as number | undefined) ?? 1,
    maxOverflowRetries: (raw.maxOverflowRetries as number | undefined) ?? 1,
    modelPolicies: Object.freeze(modelPolicies),
    auto: (raw.auto as boolean | undefined) ?? true,
  })
}

function baseSystemHead(session: any, seq: number | undefined) {
  if (seq === undefined) return undefined
  const event = session.eventAt(seq)
  return event?.type === 'system/message' ? event : undefined
}

/** Independent reproduction of `buildSummarizationInput` (`dsh-compaction-basic.js:695-704`). */
function buildBaseInput(session: any, shadowedSeqs: number[]) {
  const head = baseSystemHead(session, session.surface.nodes[0])
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((msg) => msg !== null)
  const header = session.requestHeader?.()
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

/** Independent reproduction of `selectCompactableRange` (`dsh-compaction-basic.js:410-433`). */
function baseSelectRange(session: any, measurement: any, retainTokens: number): { start: number; end: number } | null {
  const pricedNodes: Array<{ seq: number; tokens: number }> = measurement.nodes
  if (pricedNodes.length === 0) return null
  const surfaceNodes: number[] = session.surface.nodes
  if (
    surfaceNodes.length !== pricedNodes.length ||
    surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)
  ) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }
  const firstIdx = baseSystemHead(session, surfaceNodes[0]) === undefined ? 0 : 1
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return { start: surfaceNodes[firstIdx]!, end: surfaceNodes[keepFromIdx - 1]! }
}

function baseResolvePolicy(config: any, target: { provider: string; model: string }) {
  const override = config.modelPolicies.find(
    (p: any) => p.provider === target.provider && p.model === target.model,
  )
  const inheritedRetention =
    config.retainTokens === undefined ? { retainRatio: config.retainRatio } : { retainTokens: config.retainTokens }
  const retention =
    override?.retainTokens !== undefined
      ? { retainTokens: override.retainTokens }
      : override?.retainRatio !== undefined
        ? { retainRatio: override.retainRatio }
        : inheritedRetention
  return {
    target,
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...retention,
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  }
}

export { baseResolvePolicy, baseSelectRange, buildBaseInput, resolveBaseConfig }

/** Contract-faithful stand-in for the DSH base compaction engine. */
export class BasicCompactionEngine {
  readonly ctx: any
  readonly config: any
  /** Every payload the model was asked to summarize, in order. */
  readonly summarizeInputs: any[] = []
  /** Every base-class method executed. */
  readonly calls: RecordedCall[] = []
  /** Optional hook allowing tests to delay or fail the LLM call inside `super.summarize`. */
  summarizeImpl?: (input: any, agent: any, signal?: AbortSignal) => Promise<any>

  constructor(ctx: any, config: Record<string, unknown> = {}) {
    this.ctx = ctx
    this.config = resolveBaseConfig(config)
  }

  /** Records the payload and returns a distinguishable summary (unless `summarizeImpl` overrides). */
  async summarize(input: any, agent: any, signal?: AbortSignal) {
    this.calls.push({ method: 'summarize', detail: input })
    this.summarizeInputs.push(input)
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
    }
    if (this.summarizeImpl !== undefined) {
      return this.summarizeImpl(input, agent, signal)
    }
    return { summary: [{ type: 'text', text: 'fresh-summary' }], provider: 'fake', model: 'fake' }
  }

  /** Mirrors `BasicCompactionEngine.compactIfNeeded` (`dsh-compaction-basic.js:914-961`). */
  async compactIfNeeded(agent: any, trigger: 'pressure' | 'context-overflow', signal?: AbortSignal) {
    this.calls.push({ method: 'compactIfNeeded', detail: trigger })
    const headerConfig = agent.session.requestHeader?.()?.config
    if (!headerConfig?.provider || !headerConfig?.model) return null
    const target = { provider: headerConfig.provider, model: headerConfig.model }
    const policy = baseResolvePolicy(this.config, target)
    let measurement = this.ctx.tokenMeter.measure(agent.session)
    const pruner = this.ctx.get?.('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (pruner !== undefined) {
        pruner.pruneSession(agent.session)
        measurement = this.ctx.tokenMeter.measure(agent.session)
      }
      const range = baseSelectRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    const contextWindow = info?.context?.contextWindow
    if (typeof contextWindow !== 'number' || contextWindow <= 0) return null
    const reserved = headerConfig.maxTokens ?? info.defaultMaxTokens ?? 0
    const messageBudget = contextWindow - reserved
    const pressureBudget = messageBudget - policy.headroomTokens
    if (messageBudget <= 0 || pressureBudget <= 0) return null
    const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget))
    const retainTokens =
      policy.retainTokens === undefined ? Math.floor(messageBudget * policy.retainRatio) : policy.retainTokens

    if (measurement.totalTokens < thresholdTokens) return null
    if (pruner !== undefined) {
      pruner.pruneSession(agent.session)
      measurement = this.ctx.tokenMeter.measure(agent.session)
      if (measurement.totalTokens < thresholdTokens) return null
    }

    const range = baseSelectRange(agent.session, measurement, retainTokens)
    if (range === null) return null
    return this.compactRegion(range.start, range.end, agent, signal)
  }

  /** Mirrors `compactSurfaceRegion`: validates span & pairing, summarizes, checks shrink, folds. */
  async compactRegion(start: number, end: number, agent: any, signal?: AbortSignal) {
    this.calls.push({ method: 'compactRegion', detail: { start, end } })
    const nodes: number[] = agent.session.surface.nodes
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
      throw new Error('fake: span outside the current surface')
    }
    if (!toolPairingBalancedBefore(agent.session, start) || !toolPairingBalancedAfter(agent.session, end)) {
      throw new Error('fake: span violates tool-pairing balance')
    }
    const seqs = nodes.slice(startIdx, endIdx + 1)
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    let shadowedTokenCount = 0
    for (const node of measurement.nodes) {
      if (seqs.includes(node.seq)) shadowedTokenCount += node.tokens
    }

    const input = buildBaseInput(agent.session, seqs)
    const result = await this.summarize(input, agent, signal)
    const checkpointMessage = { role: 'user', content: result.summary }
    const framedTokens = this.ctx.tokenMeter.estimateMessage(checkpointMessage)
    if (framedTokens >= shadowedTokenCount) {
      throw new Error(
        `compaction: summary is not smaller than the shadowed content (${framedTokens} >= ${shadowedTokenCount})`,
      )
    }

    const summarySeq = agent.session.replaceSpan(start, end, framedTokens)
    return {
      compactionId: `fake-${start}-${end}`,
      startSeq: start,
      summarySeq,
      endSeq: end,
      summary: result.summary,
      shadowedRange: { start, end },
      shadowedSeqs: seqs,
      shadowedTokenCount,
    }
  }

  /** Mirrors manual `/compact` (`retainTokens = 0`). */
  async compactNow(agent: any, signal: AbortSignal, sourceCommandId?: string) {
    this.calls.push({ method: 'compactNow', detail: sourceCommandId })
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const range = baseSelectRange(agent.session, measurement, 0)
    if (range === null) return null
    return this.compactRegion(range.start, range.end, agent, signal)
  }
}
