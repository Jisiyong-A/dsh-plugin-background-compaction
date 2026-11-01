/**
 * Background-compaction engine.
 *
 * `BasicCompactionEngine` is DSH's sole `ctx.compaction` implementation per context
 * (`CompactionEngine extends Service`, constructor `super(ctx, 'compaction')`), so this
 * plugin replaces `compaction-basic` rather than running beside it. The subclass keeps
 * all of the framework's compaction invariants (span validation, durable
 * `compaction/start` + `compaction/end` markers, shrink check, `SurfaceChangedError`
 * guard, surface folding, tool-result pruning) and changes only when the summary text
 * is produced.
 *
 * While a conversation is between `precomputeAtRatio * thresholdTokens` and
 * `thresholdTokens`, a debounced background task pins the span the base engine would
 * select right now, summarizes those immutable surface seqs, and holds the result.
 * When pressure later crosses `thresholdTokens`, `compactIfNeeded` runs the optional
 * tool-result pruner, verifies the pinned span and payload+model fingerprint up front,
 * and commits that pinned span via `compactRegion()` with zero foreground LLM latency.
 * Any mismatch or rejection falls back cleanly to a single stock `super.compactIfNeeded()`
 * pass.
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type {
  AgentLike,
  CompactionResult,
  SessionLike,
  SummarizationInput,
  SummaryResult,
} from '@deepseek-ai/dsh-compaction-basic'

import {
  pickBaseConfig,
  resolveBackgroundConfig,
  type BackgroundCompactionOptions,
} from './config.js'
import { SpeculationGate, type SpeculationStats } from './gate.js'
import { buildSummarizationInput, fingerprintSummarizationInput } from './input.js'
import { resolveSpecForAgent, resolveSummarizerEnvelope } from './spec.js'
import { selectPrecomputeRange, type PairingGuard, type PrecomputeRange } from './span.js'
import { HeldSummaryStore, type HeldSummary } from './stash.js'

/** Payload shape of the `agent/pre-step` hook. */
interface PreStepPayload {
  agent: AgentLike
  signal?: AbortSignal
}

/** Tool-pairing predicates from `@deepseek-ai/dsh-compaction`. */
const PAIRING_GUARD: PairingGuard = {
  balancedBefore: toolPairingBalancedBefore,
  balancedAfter: toolPairingBalancedAfter,
}

/** Read `DBG_BGC` once per engine mount rather than on every step. */
function environmentTraceEnabled(): boolean {
  const raw = typeof process === 'undefined' ? undefined : process.env?.DBG_BGC
  return raw !== undefined && raw !== '' && raw !== '0' && raw !== 'false'
}

/** Human-readable one-liner for an unknown thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * `ctx.compaction` implementation that precomputes and serves held summaries.
 */
export class BackgroundCompactionEngine extends BasicCompactionEngine {
  private readonly background: Readonly<BackgroundCompactionOptions>
  private readonly traceActive: boolean
  private readonly held: HeldSummaryStore
  private readonly gate: SpeculationGate
  private readonly guard: PairingGuard = PAIRING_GUARD
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Map<string, AbortController>()
  private readonly committingHeld = new Set<string>()
  private readonly directManaged = new Set<string>()
  private readonly directServed = new Set<string>()
  private cleanupListeners: (() => void) | null = null
  private disposed = false

  constructor(ctx: BasicCompactionEngine['ctx'], config?: Record<string, unknown>) {
    super(ctx, pickBaseConfig(config))
    this.background = resolveBackgroundConfig(config)
    this.traceActive = this.background.trace || environmentTraceEnabled()
    this.held = new HeldSummaryStore(this.background.maxSessions)
    this.gate = new SpeculationGate({
      enabled: this.background.gateEnabled,
      windowSize: this.background.gateWindow,
      minHitRate: this.background.gateMinHitRate,
      cooldownMs: this.background.gateCooldownMs,
    })
    const speculating = this.background.enabled && this.config.auto
    if (speculating) this.bindSpeculation()
    this.trace(
      () =>
        `engine mounted auto=${String(this.config.auto)} enabled=${String(this.background.enabled)}` +
        ` speculating=${String(speculating)}`,
    )
  }

  /** Observed speculative outcomes; exposed for diagnostics and tests. */
  get speculationStats(): SpeculationStats {
    return this.gate.stats()
  }

  /** Number of live summaries currently held ready to serve. */
  get heldCount(): number {
    this.sweepExpired(Date.now())
    return this.held.size
  }

  /**
   * Summarize a payload, serving a matching precomputed result when one exists.
   *
   * Every foreground compaction (`compactRegion`, `context-overflow`, manual `compactNow`)
   * enters here. Background precomputation calls `super.summarize()` directly and never
   * re-enters this method.
   */
  async summarize(input: SummarizationInput, agent: AgentLike, signal?: AbortSignal): Promise<SummaryResult> {
    if (!this.background.enabled) return super.summarize(input, agent, signal)

    const sessionId = agent.session.id
    const now = Date.now()
    this.sweepExpired(now)
    const envelope = resolveSummarizerEnvelope(this.config, agent)
    const fingerprint = fingerprintSummarizationInput(input, envelope)
    const held = this.held.peek(sessionId, now)

    // Staged commit from compactIfNeeded('pressure'): hit/miss accounting runs after
    // compactRegion completes its shrink and surface-stability checks.
    if (this.committingHeld.has(sessionId)) {
      if (held !== undefined && held.fingerprint === fingerprint) {
        return held.result
      }
      throw new Error('background-compaction: held payload drifted before summarize')
    }

    // Direct foreground summarization (`super.compactIfNeeded` or `compactNow`):
    // cancel any competing background work for this session immediately.
    this.cancelBackground(sessionId, 'foreground summarize')

    if (held !== undefined) {
      this.held.delete(sessionId)
      if (held.fingerprint === fingerprint) {
        if (this.directManaged.has(sessionId)) {
          this.directServed.add(sessionId)
        } else {
          this.gate.recordHit(now)
        }
        this.trace(() => `served held summary on direct path session=${sessionId}`)
        return held.result
      }
      this.gate.recordMiss(now)
      this.trace(() => `dropped stale held summary session=${sessionId}`)
    }
    return super.summarize(input, agent, signal)
  }

  /**
   * Manual `/compact` entry point: cancels competing background work and defers hit/miss
   * booking until the base commit finishes.
   */
  async compactNow(
    agent: AgentLike,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    if (!this.background.enabled) return super.compactNow(agent, signal, sourceCommandId)
    this.sweepExpired(Date.now())
    const sessionId = agent.session.id
    this.cancelBackground(sessionId, 'compactNow')
    return this.runDirectForeground(sessionId, () => super.compactNow(agent, signal, sourceCommandId))
  }

  /**
   * Compact when pressure is reached, preferring a verified held summary's pinned span
   * and delegating cleanly to `BasicCompactionEngine` in every other case.
   */
  async compactIfNeeded(
    agent: AgentLike,
    trigger: 'pressure' | 'context-overflow',
    signal?: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (!this.background.enabled) return super.compactIfNeeded(agent, trigger, signal)

    const now = Date.now()
    this.sweepExpired(now)
    const sessionId = agent.session.id

    if (trigger !== 'pressure') {
      this.cancelBackground(sessionId, trigger)
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    }

    const held = this.held.peek(sessionId, now)
    if (held === undefined) {
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    }

    let spec
    try {
      spec = await resolveSpecForAgent(this.config, this.ctx.llm, agent, signal)
    } catch (error) {
      this.trace(() => `spec resolution failed: ${describeError(error)}`)
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    }
    if (spec === null) {
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    }

    let measurement = this.ctx.tokenMeter.measure(agent.session)
    this.trace(
      () =>
        `compactIfNeeded trigger=${trigger} tokens=${measurement.totalTokens}` +
        ` threshold=${spec.thresholdTokens} held=${this.held.size} session=${sessionId}`,
    )

    // P0-2: never swallow below-threshold checks with `return null` — delegate so the
    // base engine stays authoritative even if capacities or policies ever diverge.
    if (measurement.totalTokens < spec.thresholdTokens) {
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    }

    // Session is at pressure; stop any pending/running background work for it.
    this.cancelBackground(sessionId, 'pressure compaction')

    // P1-1: mirror the base engine's tool-result pruning pass before deciding to compact.
    const pruner = this.ctx.get?.('toolResultPruner')
    if (pruner !== undefined) {
      pruner.pruneSession(agent.session)
      measurement = this.ctx.tokenMeter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) {
        if (!this.matchesHeldPayload(agent, held)) {
          this.held.delete(sessionId)
          this.gate.recordMiss(Date.now())
          this.trace(() => `dropped held summary invalidated by tool-result pruner session=${sessionId}`)
        }
        return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
      }
    }

    // P1-2: verify span integrity and payload+model fingerprint BEFORE calling
    // compactRegion so a stale held entry never causes two foreground LLM calls.
    if (!this.matchesHeldPayload(agent, held)) {
      this.held.delete(sessionId)
      this.gate.recordMiss(Date.now())
      this.trace(() => `held summary drifted before commit session=${sessionId}; delegating`)
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    }

    // P1-3: book a hit only AFTER compactRegion validates shrink & surface stability.
    this.committingHeld.add(sessionId)
    let committed: CompactionResult
    try {
      committed = await this.compactRegion(held.range.start, held.range.end, agent, signal)
      this.held.delete(sessionId)
      this.gate.recordHit(Date.now())
      this.trace(() => `served held summary session=${sessionId} saved~${held.range.shadowedTokens}t`)
    } catch (error) {
      const dropped = this.held.delete(sessionId)
      if (dropped !== undefined) this.gate.recordMiss(Date.now())
      this.trace(() => `pinned span rejected session=${sessionId}: ${describeError(error)}`)
      if (signal?.aborted) throw error
      return this.runDirectForeground(sessionId, () => super.compactIfNeeded(agent, trigger, signal))
    } finally {
      this.committingHeld.delete(sessionId)
    }

    const after = this.ctx.tokenMeter.measure(agent.session)
    if (after.totalTokens < spec.thresholdTokens) return committed
    const followUp = await this.runDirectForeground(sessionId, () =>
      super.compactIfNeeded(agent, trigger, signal),
    )
    return followUp ?? committed
  }

  /**
   * Stop timers, cancel in-flight background calls, detach listeners, and clear the stash.
   *
   * Note: Cordis `Service` and `BasicCompactionEngine` do NOT define `dispose()`; automatic
   * lifecycle teardown runs via `ctx.effect()`, and this method is a safe idempotent
   * imperative entry point for callers and tests (must never call `super.dispose()`).
   */
  dispose(): void {
    this.teardown()
  }

  /** Run a base foreground operation, booking a direct-path hit only once it commits. */
  private async runDirectForeground<T extends CompactionResult | null>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.directManaged.add(sessionId)
    this.directServed.delete(sessionId)
    try {
      const result = await operation()
      if (this.directServed.delete(sessionId)) {
        if (result !== null) this.gate.recordHit(Date.now())
        else this.gate.recordMiss(Date.now())
      }
      return result
    } catch (error) {
      if (this.directServed.delete(sessionId)) {
        this.gate.recordMiss(Date.now())
      }
      throw error
    } finally {
      this.directManaged.delete(sessionId)
    }
  }

  /** Bind the debounced speculation trigger for the lifetime of the owning Cordis fiber. */
  private bindSpeculation(): void {
    this.ctx.effect(() => {
      const offPreStep = this.ctx.on('agent/pre-step', (payload: PreStepPayload, next: () => unknown) => {
        this.schedulePrecompute(payload.agent)
        return next()
      })
      const offDisposed = this.ctx.on('session/disposed', (session: SessionLike) => {
        this.forgetSession(session.id)
      })
      this.cleanupListeners = () => {
        offPreStep()
        offDisposed()
      }
      return () => {
        this.teardown()
      }
    })
  }

  /** Idempotent resource cleanup shared by fiber unload and `dispose()`. */
  private teardown(): void {
    if (this.disposed) return
    this.disposed = true
    this.cleanupListeners?.()
    this.cleanupListeners = null
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    for (const controller of this.running.values()) {
      try {
        controller.abort(new Error('background compaction engine disposed'))
      } catch {
        /* abort must never throw out of teardown */
      }
    }
    this.running.clear()
    this.committingHeld.clear()
    this.directManaged.clear()
    this.directServed.clear()
    this.held.clear()
  }

  /** Sweep expired held summaries and record each as a miss. */
  private sweepExpired(now: number): void {
    for (const _ of this.held.sweep(now)) {
      this.gate.recordMiss(now)
      this.trace(() => 'expired held summary')
    }
  }

  /** Cancel any pending timer or in-flight background summarization for one session. */
  private cancelBackground(sessionId: string, reason: string): void {
    const timer = this.pending.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pending.delete(sessionId)
    }
    const controller = this.running.get(sessionId)
    if (controller !== undefined) {
      this.running.delete(sessionId)
      try {
        controller.abort(new Error(`background precompute cancelled: ${reason}`))
      } catch {
        /* ignore */
      }
    }
  }

  /** Drop every trace of a disposed session. */
  private forgetSession(sessionId: string): void {
    this.cancelBackground(sessionId, 'session disposed')
    this.held.delete(sessionId)
  }

  /** True when `range` still sits intact and tool-pairing-balanced on `session.surface`. */
  private isHeldSpanIntact(session: SessionLike, range: PrecomputeRange): boolean {
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(range.start)
    if (startIdx < 0) return false
    const endIdx = nodes.indexOf(range.end)
    if (endIdx < startIdx) return false
    if (endIdx - startIdx + 1 !== range.seqs.length) return false
    for (let index = 0; index < range.seqs.length; index += 1) {
      if (nodes[startIdx + index] !== range.seqs[index]) return false
    }
    try {
      return this.guard.balancedBefore(session, range.start) && this.guard.balancedAfter(session, range.end)
    } catch {
      return false
    }
  }

  /** True when `held`'s span, derived messages, tools, and summarizer envelope still match. */
  private matchesHeldPayload(agent: AgentLike, held: HeldSummary): boolean {
    if (!this.isHeldSpanIntact(agent.session, held.range)) return false
    try {
      const input = buildSummarizationInput(agent.session, held.range.seqs)
      const envelope = resolveSummarizerEnvelope(this.config, agent)
      return fingerprintSummarizationInput(input, envelope) === held.fingerprint
    } catch {
      return false
    }
  }

  /** Debounce a precompute pass for one agent. */
  private schedulePrecompute(agent: AgentLike): void {
    if (this.disposed) return
    const now = Date.now()
    this.sweepExpired(now)
    const sessionId = agent.session.id
    if (this.running.has(sessionId) || this.committingHeld.has(sessionId)) return
    if (this.held.peek(sessionId, now) !== undefined) return

    const existing = this.pending.get(sessionId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pending.delete(sessionId)
      void this.runPrecompute(agent)
    }, this.background.debounceMs)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
    this.pending.set(sessionId, timer)
  }

  /** Summarize the span the foreground engine would pick now, and hold the result. */
  private async runPrecompute(agent: AgentLike): Promise<void> {
    if (this.disposed) return
    const sessionId = agent.session.id
    this.sweepExpired(Date.now())
    if (this.running.has(sessionId) || this.committingHeld.has(sessionId)) return
    if (this.running.size >= this.background.maxConcurrent) {
      this.trace(() => `skip session=${sessionId}: concurrency limit`)
      return
    }

    // P1-5: reserve the concurrency slot synchronously BEFORE any `await` so overlapping
    // timers cannot exceed `maxConcurrent` or launch duplicate jobs for one session.
    const controller = new AbortController()
    this.running.set(sessionId, controller)
    let llmStarted = false

    try {
      const spec = await resolveSpecForAgent(this.config, this.ctx.llm, agent, controller.signal)
      if (this.disposed || controller.signal.aborted) return
      if (spec === null) {
        this.trace(
          () => `skip session=${sessionId}: no routed target header=${JSON.stringify(agent.session.requestHeader?.()?.config ?? null)}`,
        )
        return
      }

      const measurement = this.ctx.tokenMeter.measure(agent.session)
      const watermark = Math.floor(spec.thresholdTokens * this.background.precomputeAtRatio)
      if (measurement.totalTokens < watermark) {
        this.trace(
          () =>
            `below watermark session=${sessionId} tokens=${measurement.totalTokens}` +
            ` watermark=${watermark} threshold=${spec.thresholdTokens}`,
        )
        return
      }
      if (measurement.totalTokens >= spec.thresholdTokens) {
        this.trace(() => `skip session=${sessionId}: already at pressure, foreground owns it`)
        return
      }

      const now = Date.now()
      if (!this.gate.shouldSpeculate(now)) {
        this.trace(() => `skip session=${sessionId}: gate paused ${JSON.stringify(this.gate.stats())}`)
        return
      }
      if (this.held.peek(sessionId, now) !== undefined) return

      const range = selectPrecomputeRange(agent.session, measurement, spec.retainTokens, this.guard)
      if (range === null) {
        this.trace(() => `no precompute range session=${sessionId} tokens=${measurement.totalTokens}`)
        return
      }
      if (range.shadowedTokens < this.background.minShadowTokens) {
        this.trace(() => `skip session=${sessionId}: span too small (${range.shadowedTokens}t)`)
        return
      }

      const input = buildSummarizationInput(agent.session, range.seqs)
      const envelope = resolveSummarizerEnvelope(this.config, agent)
      const fingerprint = fingerprintSummarizationInput(input, envelope)

      this.trace(() => `precompute start session=${sessionId} span=${range.start}..${range.end} tokens=${range.shadowedTokens}`)
      llmStarted = true
      const result = await super.summarize(input, agent, controller.signal)
      if (this.disposed || controller.signal.aborted) return

      const settledAt = Date.now()
      const displaced = this.held.set(sessionId, {
        fingerprint,
        range,
        result,
        expiresAt: settledAt + this.background.heldTtlMs,
      })
      for (const _ of displaced) this.gate.recordMiss(settledAt)
      this.trace(() => `precompute ready session=${sessionId} held=${this.held.size}`)
    } catch (error) {
      if (this.disposed || controller.signal.aborted) {
        this.trace(() => `precompute cancelled session=${sessionId}`)
        return
      }
      if (llmStarted) this.gate.recordMiss(Date.now())
      this.trace(() => `precompute failed session=${sessionId}: ${describeError(error)}`)
    } finally {
      if (this.running.get(sessionId) === controller) this.running.delete(sessionId)
    }
  }

  /** Lazily format and emit one trace line when tracing is active. */
  private trace(buildMessage: () => string): void {
    if (!this.traceActive) return
    try {
      const line = `[bgc] ${buildMessage()}`
      this.ctx.logger.debug?.(line)
      process.stderr.write(`${line}\n`)
    } catch {
      /* tracing must never break compaction */
    }
  }
}

export default BackgroundCompactionEngine
