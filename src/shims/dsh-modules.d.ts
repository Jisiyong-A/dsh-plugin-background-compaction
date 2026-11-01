// Ambient type declarations for the DSH runtime packages this plugin links against.
//
// DSH 0.2.1-rc.5 does NOT install these packages next to a linked plugin. Its boot
// layer (dsh-app-boot `routeLinked`) intercepts a linked plugin's bare
// `@deepseek-ai/*` imports and routes them to the copy inside app.asar *provided the
// importing package declares the name in its own `peerDependencies`*. Without that
// declaration the import silently falls back to the stale copy under
// `~/.dsh/profiles/node_modules` (0.1.1-rc.2) — a version-skew failure that is
// invisible at runtime. `package.json` therefore declares every name below under
// `peerDependencies`, and esbuild keeps them external.
//
// The shapes below mirror `dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`,
// `dsh/node_modules/@deepseek-ai/dsh-compaction/lib/index.js`, and
// `dsh/node_modules/@deepseek-ai/cordis/lib/index.js` as shipped in app.asar 0.2.1-rc.5.

declare module '@deepseek-ai/dsh-compaction' {
  /** Inclusive positional surface span handed to a compaction transaction. */
  export interface SurfaceSpan {
    /** Inclusive first surface-node seq. */
    start: number
    /** Inclusive last surface-node seq. */
    end: number
  }

  /**
   * True when `seq` is a legal compaction *start* boundary: the preceding surface
   * content does not end inside a tool-call/tool-result pair.
   */
  export function toolPairingBalancedBefore(session: unknown, seq: number): boolean

  /**
   * True when `seq` is a legal compaction *end* boundary: the step at `seq` is
   * closed, so replacing through it cannot split a step or leave one open.
   */
  export function toolPairingBalancedAfter(session: unknown, seq: number): boolean

  /** Abstract `ctx.compaction` service; one implementation per context. */
  export class CompactionEngine {
    constructor(ctx: unknown)
  }
}

declare module '@deepseek-ai/dsh-compaction-basic' {
  /** One durable message produced by a session event, as replayed to the summarizer. */
  export interface DshMessage {
    role: string
    content: unknown
    [key: string]: unknown
  }

  /** The replayed conversation prefix handed to {@link BasicCompactionEngine.summarize}. */
  export interface SummarizationInput {
    system?: DshMessage
    tools?: unknown
    messages: DshMessage[]
  }

  /** Summary blocks plus the auxiliary call envelope recorded on `compaction/summary`. */
  export interface SummaryResult {
    summary: Array<{ type: string; [key: string]: unknown }>
    provider: string
    model: string
    maxTokens?: number
    usage?: unknown
    rawOutput?: string
    llmStreamCall?: boolean
  }

  /** Durable result of one committed compaction transaction. */
  export interface CompactionResult {
    compactionId: string
    startSeq: number
    summarySeq: number
    endSeq: number
    summary: SummaryResult['summary']
    shadowedRange: import('@deepseek-ai/dsh-compaction').SurfaceSpan
    shadowedSeqs: number[]
    shadowedTokenCount: number
    sourceCommandId?: string
  }

  /** One priced surface position reported by `ctx.tokenMeter.measure()`. */
  export interface MeasuredNode {
    seq: number
    /** Route-priced tokens for this node. */
    tokens: number
    /** Meter-local heuristic tokens for this node. */
    heuristicTokens: number
  }

  /** Unified pressure and surface measurement from the conversation token meter. */
  export interface SessionMeasurement {
    nodes: MeasuredNode[]
    totalTokens: number
  }

  /** Append-only log record for one session position. */
  export interface SessionEvent {
    type: string
    seq: number
    data?: Record<string, unknown>
    [key: string]: unknown
  }

  /** The routed request envelope durably recorded for the latest model request. */
  export interface RequestHeader {
    tools?: unknown
    config?: {
      provider: string
      model: string
      maxTokens?: number
      [key: string]: unknown
    }
    [key: string]: unknown
  }

  /** The live session surface: an append-only log plus a foldable node list. */
  export interface SessionLike {
    id: string
    seq: number
    surface: { nodes: number[] }
    requestHeader(): RequestHeader | undefined
    eventAt(seq: number): SessionEvent
    deriveEventMessage(event: SessionEvent): DshMessage | null
  }

  /** The owning agent for the session being compacted. */
  export interface AgentLike {
    session: SessionLike
    options?: { provider?: string; model?: string }
    runMaintenance?<T>(cb: (signal: AbortSignal) => Promise<T>): Promise<T>
  }

  /** Resolved model routing facts for one provider/model target. */
  export interface ModelInfo {
    context?: { contextWindow: number }
    defaultMaxTokens?: number
    [key: string]: unknown
  }

  /**
   * One entry in `ResolvedBasicConfig.modelPolicies` (`dsh-compaction-basic/lib/index.js:43-57`).
   * Note: `provider` and `model` sit at the top level — there is NO `.target` wrapper here.
   */
  export interface ModelPolicy {
    provider: string
    model: string
    thresholdRatio?: number
    headroomTokens?: number
    retainRatio?: number
    retainTokens?: number
    summarizationProvider?: string
    summarizationModel?: string
    maxTokens?: number
    compactionRetries?: number
    maxOverflowRetries?: number
  }

  /** Detached, merged policy for one exact routed target (`resolveTargetPolicy`). */
  export interface TargetPolicy {
    target: { provider: string; model: string }
    thresholdRatio: number
    headroomTokens: number
    retainRatio?: number
    retainTokens?: number
    summarizationProvider: string
    summarizationModel: string
    maxTokens: number
    compactionRetries: number
    maxOverflowRetries: number
  }

  /** Fully resolved, frozen basic-compaction configuration (`resolveConfig`). */
  export interface ResolvedBasicConfig {
    thresholdRatio: number
    headroomTokens: number
    retainRatio?: number
    retainTokens?: number
    summarizationProvider: string
    summarizationModel: string
    maxTokens: number
    compactionRetries: number
    maxOverflowRetries: number
    modelPolicies: readonly ModelPolicy[]
    auto: boolean
  }

  /** Optional tool-result pruner service registered as `ctx.get('toolResultPruner')`. */
  export interface ToolResultPrunerService {
    pruneSession(session: SessionLike): void
  }

  /**
   * Token-meter-driven compaction backend. `summarize()` is the documented subclass
   * customization hook; region selection, durable markers and surface folding stay
   * inside the base class. Note that neither Cordis `Service` nor `BasicCompactionEngine`
   * defines a `dispose()` method — lifecycle teardown runs through `ctx.effect()`.
   */
  export class BasicCompactionEngine {
    constructor(ctx: unknown, config?: Record<string, unknown>)
    /** The cordis context the service was mounted into. */
    readonly ctx: {
      logger: {
        debug?(message: string): void
        info(message: string): void
        warn(message: string): void
        error(message: string): void
      }
      tokenMeter: {
        measure(session: SessionLike): SessionMeasurement
        estimateMessage(message: unknown): number
      }
      llm: {
        resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo>
      }
      sessions: { flush(session: SessionLike): Promise<void> }
      get?(name: 'toolResultPruner'): ToolResultPrunerService | undefined
      on(event: string, listener: (...args: any[]) => any): () => void
      effect(callback: () => void | (() => void)): void
    }
    /** Resolved configuration produced by the base class. */
    readonly config: ResolvedBasicConfig
    summarize(
      input: SummarizationInput,
      agent: AgentLike,
      signal?: AbortSignal,
    ): Promise<SummaryResult>
    compactIfNeeded(
      agent: AgentLike,
      trigger: 'pressure' | 'context-overflow',
      signal?: AbortSignal,
    ): Promise<CompactionResult | null>
    compactRegion(
      start: number,
      end: number,
      agent: AgentLike,
      signal?: AbortSignal,
    ): Promise<CompactionResult>
    compactNow(
      agent: AgentLike,
      signal: AbortSignal,
      sourceCommandId?: string,
    ): Promise<CompactionResult | null>
  }
}
