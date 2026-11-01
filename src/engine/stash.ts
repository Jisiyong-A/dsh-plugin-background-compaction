/**
 * Held-summary stash.
 *
 * Stores at most one precomputed summary per session, pinned to the exact surface span
 * and summarizer target it was built from. Lookups (`peek`) are non-mutating so expired
 * entries are never silently dropped behind the caller's back — `sweep()` and `set()`
 * surface every expired, superseded, or capacity-evicted entry so the speculation gate
 * accounts for every unused background call.
 */

import type { SummaryResult } from '@deepseek-ai/dsh-compaction-basic'

import type { PrecomputeRange } from './span.js'

/** One precomputed summary awaiting a matching compaction. */
export interface HeldSummary {
  /** SHA-256 fingerprint of the payload and summarizer envelope that produced `result`. */
  fingerprint: string
  /** Surface span this summary replaces. */
  range: PrecomputeRange
  /** Complete summary payload returned by the summarizer. */
  result: SummaryResult
  /** Epoch millis after which the entry is unusable. */
  expiresAt: number
}

/**
 * Bounded, TTL-scoped store of precomputed summaries keyed by session id.
 *
 * Not safe for cross-thread use; everything here runs on the host event loop.
 */
export class HeldSummaryStore {
  private readonly entries = new Map<string, HeldSummary>()

  /**
   * @param maxSessions - hard cap on tracked sessions; the oldest stored entry is
   *   evicted past the cap so a long-lived host cannot leak memory.
   */
  constructor(private readonly maxSessions: number) {}

  /**
   * Store a freshly prepared summary, replacing any previous entry for the session and
   * enforcing the `maxSessions` cap.
   *
   * @param sessionId - owning session.
   * @param entry - the prepared summary.
   * @returns every entry displaced by this write (superseded or capacity-evicted).
   */
  set(sessionId: string, entry: HeldSummary): HeldSummary[] {
    const displaced: HeldSummary[] = []
    const previous = this.entries.get(sessionId)
    if (previous !== undefined) {
      this.entries.delete(sessionId)
      displaced.push(previous)
    }
    this.entries.set(sessionId, entry)
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.entries().next()
      if (oldest.done === true) break
      const [oldestKey, oldestEntry] = oldest.value
      this.entries.delete(oldestKey)
      displaced.push(oldestEntry)
    }
    return displaced
  }

  /**
   * Inspect a live entry without mutating the store.
   *
   * Expired entries remain in the map until {@link sweep}, {@link set}, or
   * {@link delete} removes them so expiry accounting is never lost.
   */
  peek(sessionId: string, now: number): HeldSummary | undefined {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.expiresAt <= now) return undefined
    return entry
  }

  /** Drop an entry unconditionally and return it if present. */
  delete(sessionId: string): HeldSummary | undefined {
    const entry = this.entries.get(sessionId)
    if (entry !== undefined) this.entries.delete(sessionId)
    return entry
  }

  /** Remove and return every entry whose TTL has elapsed. */
  sweep(now: number): HeldSummary[] {
    const expired: HeldSummary[] = []
    for (const [sessionId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(sessionId)
        expired.push(entry)
      }
    }
    return expired
  }

  /** Number of entries currently stored (call {@link sweep} first for live count). */
  get size(): number {
    return this.entries.size
  }

  /** Drop every entry without accounting (used on service teardown). */
  clear(): void {
    this.entries.clear()
  }
}
