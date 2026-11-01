/**
 * Anchored pressure math and summarizer-target resolution.
 *
 * Mirrors `resolveTargetPolicy()`, `resolveCompactSpec()`, `routedTarget()`, and
 * `summarizeWithLlm()` target selection in `dsh-compaction-basic/lib/index.js`
 * (lines 94-147, 293-303, 743-769, 899-903) so the plugin's watermark, retention
 * budget, and summary-cache fingerprint stay in exact lockstep with the base engine.
 */

import type {
  AgentLike,
  ModelInfo,
  ModelPolicy,
  ResolvedBasicConfig,
  SessionLike,
  TargetPolicy,
} from '@deepseek-ai/dsh-compaction-basic'

/** The provider/model pair durably routed for the latest request. */
export interface RoutedTarget {
  provider: string
  model: string
}

/** Concrete token budgets for one routed target. */
export interface CompactSpec {
  provider: string
  model: string
  contextWindow: number
  /** Total estimated tokens at which the foreground engine compacts. */
  thresholdTokens: number
  /** Minimum recent tail retained verbatim by a compaction. */
  retainTokens: number
}

/** Effective LLM parameters `summarizeWithLlm` would use right now. */
export interface SummarizerEnvelope {
  provider: string
  model: string
  maxTokens: number
}

/** Resolve the exact provider/model the latest request was routed to. */
export function routedTarget(session: SessionLike): RoutedTarget | null {
  const config = session.requestHeader()?.config
  if (config === undefined) return null
  if (typeof config.provider !== 'string' || config.provider.length === 0) return null
  if (typeof config.model !== 'string' || config.model.length === 0) return null
  return { provider: config.provider, model: config.model }
}

/** Fallback target configured on the agent before any request has been routed. */
function agentTarget(agent: AgentLike): RoutedTarget | null {
  const options = agent.options
  if (options === undefined) return null
  if (typeof options.provider !== 'string' || options.provider.length === 0) return null
  if (typeof options.model !== 'string' || options.model.length === 0) return null
  return { provider: options.provider, model: options.model }
}

/** Choose an explicit retention form or inherit the already-resolved fallback. */
function resolveRetention(
  policy: ModelPolicy | undefined,
  fallback: { retainRatio?: number; retainTokens?: number },
): { retainRatio?: number; retainTokens?: number } {
  if (policy?.retainTokens !== undefined) return { retainTokens: policy.retainTokens }
  if (policy?.retainRatio !== undefined) return { retainRatio: policy.retainRatio }
  return fallback
}

/**
 * Merge an exact-target `modelPolicies` override over the validated defaults, mirroring
 * `resolveTargetPolicy()` in `dsh-compaction-basic/lib/index.js:94-111`.
 */
export function resolveTargetPolicy(config: ResolvedBasicConfig, target: RoutedTarget): TargetPolicy {
  const override = config.modelPolicies.find(
    (policy) => policy.provider === target.provider && policy.model === target.model,
  )
  const inheritedRetention =
    config.retainTokens === undefined ? { retainRatio: config.retainRatio } : { retainTokens: config.retainTokens }
  return {
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  }
}

/**
 * Resolve the effective summarizer model and `maxTokens` that `BasicCompactionEngine.summarize()`
 * will use for `agent`, so a model or policy switch invalidates any held summary.
 */
export function resolveSummarizerEnvelope(config: ResolvedBasicConfig, agent: AgentLike): SummarizerEnvelope {
  const latest = routedTarget(agent.session)
  const fallback = agentTarget(agent)
  const convTarget = latest ?? fallback
  const policy = convTarget === null ? config : resolveTargetPolicy(config, convTarget)
  const configured =
    policy.summarizationProvider.length > 0 && policy.summarizationModel.length > 0
      ? { provider: policy.summarizationProvider, model: policy.summarizationModel }
      : null
  const chosen = configured ?? latest ?? fallback ?? { provider: '', model: '' }
  return {
    provider: chosen.provider,
    model: chosen.model,
    maxTokens: policy.maxTokens,
  }
}

/** Derive the pressure and retention budgets the foreground engine would use right now. */
export function resolveCompactSpec(
  config: ResolvedBasicConfig,
  target: RoutedTarget,
  info: ModelInfo,
  session: SessionLike,
): CompactSpec | null {
  const contextWindow = info.context?.contextWindow
  if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0) return null

  const policy = resolveTargetPolicy(config, target)
  const reservedCompletionTokens = session.requestHeader()?.config?.maxTokens ?? info.defaultMaxTokens ?? 0
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) return null

  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) return null
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
  if (pressureBudgetTokens <= 0) return null

  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
  const retainTokens =
    policy.retainTokens === undefined
      ? Math.floor(messageBudgetTokens * (policy.retainRatio ?? 0))
      : policy.retainTokens
  if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return null
  if (!Number.isFinite(retainTokens) || retainTokens < 0 || retainTokens >= thresholdTokens) return null

  return {
    provider: target.provider,
    model: target.model,
    contextWindow,
    thresholdTokens,
    retainTokens,
  }
}

/** Resolve the live spec for an agent, asking the adapter for that target's capacity. */
export async function resolveSpecForAgent(
  config: ResolvedBasicConfig,
  llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo> },
  agent: AgentLike,
  signal?: AbortSignal,
): Promise<CompactSpec | null> {
  const target = routedTarget(agent.session)
  if (target === null) return null
  const info = await llm.resolveModelInfo(target.provider, target.model, signal)
  return resolveCompactSpec(config, target, info, agent.session)
}
