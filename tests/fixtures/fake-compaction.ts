/**
 * Bundle-time stand-in for `@deepseek-ai/dsh-compaction`.
 *
 * Only the tool-pairing predicates matter to this plugin. Tests steer them through the
 * override sets in `session.ts` instead of constructing real tool-call/tool-result
 * pairs, which keeps span-selection cases readable.
 */

import { unbalancedAfter, unbalancedBefore } from './session.js'

/** True unless the case marks `seq` as an illegal start boundary. */
export function toolPairingBalancedBefore(_session: unknown, seq: number): boolean {
  return !unbalancedBefore.has(seq)
}

/** True unless the case marks `seq` as an illegal end boundary. */
export function toolPairingBalancedAfter(_session: unknown, seq: number): boolean {
  return !unbalancedAfter.has(seq)
}

/** Placeholder so the module shape matches the real package. */
export class CompactionEngine {}
