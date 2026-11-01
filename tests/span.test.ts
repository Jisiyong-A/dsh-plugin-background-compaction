import test from 'node:test'
import assert from 'node:assert/strict'

import { selectPrecomputeRange } from '../src/engine/span.js'
import type { PairingGuard } from '../src/engine/span.js'
import { FakeSession, resetPairingOverrides } from './fixtures/session.js'

/** Measurement shaped exactly like `ctx.tokenMeter.measure()`. */
function measure(session: FakeSession) {
  return {
    nodes: session.nodes.map((seq) => ({
      seq,
      tokens: session.tokensAt(seq),
      heuristicTokens: session.tokensAt(seq),
    })),
    totalTokens: session.totalTokens,
  }
}

/** Guard that treats every boundary as legal. */
const openGuard: PairingGuard = { balancedBefore: () => true, balancedAfter: () => true }

test('pins the span the foreground engine would compact, keeping the tail', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(5, 1000)

  const range = selectPrecomputeRange(session, measure(session), 2500, openGuard)
  assert.ok(range !== null)
  // system head at 0 is never shadowed; the retained tail starts at surface index 3.
  assert.equal(range.start, 1)
  assert.equal(range.end, 2)
  assert.deepEqual(range.seqs, [1, 2])
  assert.equal(range.shadowedTokens, 2000)
})

test('shadows from index 0 when the conversation has no system head', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1')
  session.appendTurns(4, 1000)

  const range = selectPrecomputeRange(session, measure(session), 1000, openGuard)
  assert.ok(range !== null)
  assert.equal(range.start, 0)
  assert.deepEqual(range.seqs, [0, 1, 2])
})

test('walks the boundary backwards until the start is tool-pairing balanced', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(5, 1000)
  const guard: PairingGuard = { balancedBefore: (_s, seq) => seq !== 3, balancedAfter: () => true }

  const range = selectPrecomputeRange(session, measure(session), 2500, guard)
  assert.ok(range !== null)
  assert.equal(range.start, 1)
  // boundary fell back from surface index 3 to 2, so the end moves to surface index 1.
  assert.equal(range.end, 1)
  assert.deepEqual(range.seqs, [1])
})

test('refuses a span whose end boundary would split a tool pair', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(5, 1000)
  const guard: PairingGuard = { balancedBefore: () => true, balancedAfter: (_s, seq) => seq !== 2 }
  assert.equal(selectPrecomputeRange(session, measure(session), 2500, guard), null)
})

test('refuses to compact when the retained tail covers the whole surface', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(3, 1000)
  assert.equal(selectPrecomputeRange(session, measure(session), 100000, openGuard), null)
})

test('refuses when the meter surface does not match the session surface', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(4, 1000)
  const stale = measure(session)
  stale.nodes.pop()
  assert.equal(selectPrecomputeRange(session, stale, 1000, openGuard), null)
})

test('returns null for an empty surface', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1')
  assert.equal(selectPrecomputeRange(session, measure(session), 0, openGuard), null)
})

test('a system-only surface has nothing shadowable', () => {
  resetPairingOverrides()
  const session = new FakeSession('s1', { withSystemHead: true })
  assert.equal(selectPrecomputeRange(session, measure(session), 0, openGuard), null)
})
