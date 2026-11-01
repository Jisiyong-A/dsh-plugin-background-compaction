/**
 * Sliding-window hit-rate circuit breaker for background speculation.
 *
 * Each background precompute bets one LLM summarization call to save one blocking
 * foreground summarization call. Measuring shadowed tokens is misleading because the
 * foreground path reclaims shadowed tokens too — the true economic unit is whether the
 * speculative call was actually consumed (hit) or discarded (miss).
 *
 * When the last `windowSize` settled speculations fall below `minHitRate`, the gate
 * pauses new speculations for `cooldownMs`. Once the cooldown elapses, the window is
 * cleared so the engine gets a clean recovery trial.
 */

/** Immutable snapshot of observed outcomes and circuit-breaker state. */
export interface SpeculationStats {
  /** Total precomputed summaries committed by a real compaction. */
  hits: number
  /** Total precomputed summaries that expired, were superseded, failed, or mismatched. */
  misses: number
  /** Hits inside the current sliding window. */
  windowHits: number
  /** Outcomes currently inside the sliding window (`0..options.windowSize`). */
  windowSize: number
  /** Hit rate across the current sliding window (`1` when empty). */
  hitRate: number
  /** Epoch millis until which speculation is paused (`0` when open). */
  pausedUntil: number
}

/** Tunables for {@link SpeculationGate}. */
export interface SpeculationGateOptions {
  /** Enable the circuit breaker; when false speculation is always allowed. */
  enabled: boolean
  /** Number of recent outcomes evaluated before the breaker can trip. */
  windowSize: number
  /** Minimum hit rate in `[0, 1]` over `windowSize` required to stay open. */
  minHitRate: number
  /** Duration (ms) to pause speculation when the window drops below `minHitRate`. */
  cooldownMs: number
}

/** Sliding-window circuit breaker guarding speculative background calls. */
export class SpeculationGate {
  private hits = 0
  private misses = 0
  private readonly recent: boolean[] = []
  private pausedUntil = 0

  constructor(private readonly options: SpeculationGateOptions) {}

  /** Book a precomputed summary that a real compaction committed. */
  recordHit(now: number = Date.now()): void {
    this.hits += 1
    this.pushOutcome(true, now)
  }

  /** Book a speculative attempt that did not get committed. */
  recordMiss(now: number = Date.now()): void {
    this.misses += 1
    this.pushOutcome(false, now)
  }

  /** Decide whether a new speculative summarization is allowed at `now`. */
  shouldSpeculate(now: number = Date.now()): boolean {
    if (!this.options.enabled) return true
    if (this.pausedUntil > 0) {
      if (now < this.pausedUntil) return false
      this.pausedUntil = 0
      this.recent.length = 0
      return true
    }
    if (this.recent.length < this.options.windowSize) return true
    return this.currentWindowHitRate() >= this.options.minHitRate
  }

  /** Snapshot of cumulative counters and current window state. */
  stats(): SpeculationStats {
    const windowHits = this.countWindowHits()
    return {
      hits: this.hits,
      misses: this.misses,
      windowHits,
      windowSize: this.recent.length,
      hitRate: this.currentWindowHitRate(),
      pausedUntil: this.pausedUntil,
    }
  }

  /** Reset all observations and reopen the breaker. */
  reset(): void {
    this.hits = 0
    this.misses = 0
    this.recent.length = 0
    this.pausedUntil = 0
  }

  private pushOutcome(hit: boolean, now: number): void {
    this.recent.push(hit)
    while (this.recent.length > this.options.windowSize) {
      this.recent.shift()
    }
    if (!this.options.enabled) return
    if (this.recent.length >= this.options.windowSize) {
      if (this.currentWindowHitRate() < this.options.minHitRate) {
        if (this.options.cooldownMs > 0) {
          this.pausedUntil = now + this.options.cooldownMs
        }
      } else if (hit) {
        this.pausedUntil = 0
      }
    }
  }

  private countWindowHits(): number {
    let count = 0
    for (const outcome of this.recent) {
      if (outcome) count += 1
    }
    return count
  }

  private currentWindowHitRate(): number {
    if (this.recent.length === 0) return 1
    return this.countWindowHits() / this.recent.length
  }
}
