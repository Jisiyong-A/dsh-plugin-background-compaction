/**
 * Background span selection.
 *
 * The foreground engine picks its compaction span *at pressure time* with
 * `selectCompactableRange()` (lib/index.js:410-433): it walks the priced surface
 * backwards accumulating `tokens` until the retained tail is satisfied, then walks
 * the boundary backwards until `toolPairingBalancedBefore()` holds. Because that
 * window is recomputed from the live measurement, a summary prepared for "the range
 * the engine would pick later" would almost never match the range it actually picks.
 *
 * This plugin therefore inverts the relationship: it pins a span *now*, summarizes
 * exactly those surface seqs, and later commits that same seq range. Surface nodes are
 * immutable by seq, so the summarized input stays byte-identical as the conversation
 * grows — which is what lets the held summary be served without re-summarizing. This
 * module is the pinning half and mirrors the engine's own selection so the pinned span
 * is always a legal replacement target.
 *
 * The function is deliberately free of DSH imports: the tool-pairing predicate is
 * injected, so the selection rules can be unit tested without the runtime.
 */

import type { SessionLike, SessionMeasurement } from '@deepseek-ai/dsh-compaction-basic'

/** Tool-pairing boundary predicates, injected from `@deepseek-ai/dsh-compaction`. */
export interface PairingGuard {
  /** True when `seq` is a legal compaction start boundary. */
  balancedBefore(session: SessionLike, seq: number): boolean
  /** True when `seq` is a legal compaction end boundary. */
  balancedAfter(session: SessionLike, seq: number): boolean
}

/** One pinned, tool-pair-balanced surface span plus its route-priced size. */
export interface PrecomputeRange {
  /** Inclusive first surface-node seq. */
  start: number
  /** Inclusive last surface-node seq. */
  end: number
  /** Every surface-node seq inside the span, in surface order. */
  seqs: number[]
  /** Route-priced tokens this span currently occupies. */
  shadowedTokens: number
}

/** True when surface node 0 is the `system/message` head the base class never shadows. */
function isSystemHead(session: SessionLike, seq: number): boolean {
  try {
    return session.eventAt(seq).type === 'system/message'
  } catch {
    return false
  }
}

/**
 * Pin the span the foreground engine would compact at the current pressure, keeping a
 * verbatim tail and never splitting a tool-call/tool-result pair.
 *
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the token meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param guard - tool-pairing boundary predicates.
 * @returns the pinned span, or null when no legal span exists yet.
 */
export function selectPrecomputeRange(
  session: SessionLike,
  measurement: SessionMeasurement,
  retainTokens: number,
  guard: PairingGuard,
): PrecomputeRange | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length) return null
  for (let index = 0; index < surfaceNodes.length; index += 1) {
    if (surfaceNodes[index] !== pricedNodes[index]?.seq) return null
  }

  const firstIdx = isSystemHead(session, surfaceNodes[0]) ? 1 : 0
  if (firstIdx >= surfaceNodes.length) return null
  if (!guard.balancedBefore(session, surfaceNodes[firstIdx])) return null

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null

  while (keepFromIdx > firstIdx) {
    if (guard.balancedBefore(session, surfaceNodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  const endIdx = keepFromIdx - 1
  if (!guard.balancedAfter(session, surfaceNodes[endIdx])) return null

  const seqs = surfaceNodes.slice(firstIdx, keepFromIdx)
  let shadowedTokens = 0
  for (let index = firstIdx; index < keepFromIdx; index += 1) shadowedTokens += pricedNodes[index].tokens

  return {
    start: surfaceNodes[firstIdx],
    end: surfaceNodes[endIdx],
    seqs,
    shadowedTokens,
  }
}
