import test from 'node:test'
import assert from 'node:assert/strict'

import { HeldSummaryStore, type HeldSummary } from '../src/engine/stash.js'

function entry(fingerprint: string, expiresAt = 2000): HeldSummary {
  return {
    fingerprint,
    range: { start: 0, end: 2, seqs: [0, 1, 2], shadowedTokens: 900 },
    result: { summary: [{ type: 'text', text: 'held' }], provider: 'p', model: 'm' },
    expiresAt,
  }
}

test('stores and peeks one live entry per session', () => {
  const store = new HeldSummaryStore(4)
  assert.deepEqual(store.set('s1', entry('fp-a')), [])
  assert.equal(store.size, 1)
  assert.equal(store.peek('s1', 1500)?.fingerprint, 'fp-a')
})

test('peek hides expired entries without silently deleting them before sweep', () => {
  const store = new HeldSummaryStore(4)
  store.set('s1', entry('fp-a', 2000))
  // Peek past expiry returns undefined, leaving the expired entry for sweep() to account.
  assert.equal(store.peek('s1', 2500), undefined)
  assert.equal(store.size, 1)

  const expired = store.sweep(2500)
  assert.deepEqual(expired.map((item) => item.fingerprint), ['fp-a'])
  assert.equal(store.size, 0)
})

test('set returns superseded and capacity-evicted entries for miss accounting', () => {
  const store = new HeldSummaryStore(2)
  assert.deepEqual(store.set('s1', entry('fp-1')), [])
  assert.deepEqual(
    store.set('s1', entry('fp-1b')).map((e) => e.fingerprint),
    ['fp-1'],
  )
  assert.deepEqual(store.set('s2', entry('fp-2')), [])
  // Adding s3 exceeds maxSessions=2 and evicts oldest ('s1').
  assert.deepEqual(
    store.set('s3', entry('fp-3')).map((e) => e.fingerprint),
    ['fp-1b'],
  )
  assert.equal(store.size, 2)
  assert.equal(store.peek('s1', 1500), undefined)
  assert.equal(store.peek('s2', 1500)?.fingerprint, 'fp-2')
  assert.equal(store.peek('s3', 1500)?.fingerprint, 'fp-3')
})

test('delete and clear remove entries', () => {
  const store = new HeldSummaryStore(4)
  store.set('s1', entry('fp-a'))
  assert.equal(store.delete('s1')?.fingerprint, 'fp-a')
  assert.equal(store.size, 0)

  store.set('s1', entry('fp-a'))
  store.set('s2', entry('fp-b'))
  store.clear()
  assert.equal(store.size, 0)
})
