import test from 'node:test'
import assert from 'node:assert/strict'

import { SpeculationGate } from '../src/engine/gate.js'

const options = {
  enabled: true,
  windowSize: 4,
  minHitRate: 0.5,
  cooldownMs: 10_000,
}

test('stays open while the sliding window is not yet full', () => {
  const gate = new SpeculationGate(options)
  assert.equal(gate.shouldSpeculate(1000), true)
  gate.recordMiss(1000)
  gate.recordMiss(1100)
  gate.recordMiss(1200)
  assert.equal(gate.stats().windowSize, 3)
  assert.equal(gate.shouldSpeculate(1300), true)
})

test('pauses speculation for cooldownMs once the full window falls below minHitRate', () => {
  const gate = new SpeculationGate(options)
  gate.recordMiss(1000)
  gate.recordMiss(1100)
  gate.recordMiss(1200)
  gate.recordHit(1300) // 1/4 = 0.25 < 0.5 -> trips at t=1300
  assert.equal(gate.stats().hitRate, 0.25)
  assert.equal(gate.stats().pausedUntil, 11_300)
  assert.equal(gate.shouldSpeculate(5_000), false)
  assert.equal(gate.shouldSpeculate(11_299), false)
})

test('reopens and clears the window once cooldown elapses', () => {
  const gate = new SpeculationGate(options)
  for (let i = 0; i < 4; i += 1) gate.recordMiss(1000 + i)
  assert.equal(gate.shouldSpeculate(5_000), false)

  assert.equal(gate.shouldSpeculate(11_003), true)
  const stats = gate.stats()
  assert.equal(stats.pausedUntil, 0)
  assert.equal(stats.windowSize, 0)
  // Cumulative counters remain intact across cooldown recovery.
  assert.equal(stats.misses, 4)
})

test('remains open when recent hit rate meets or exceeds minHitRate', () => {
  const gate = new SpeculationGate(options)
  gate.recordHit(100)
  gate.recordMiss(200)
  gate.recordHit(300)
  gate.recordMiss(400) // 2/4 = 0.5 >= 0.5
  assert.equal(gate.shouldSpeculate(500), true)
  assert.equal(gate.stats().pausedUntil, 0)
})

test('sliding window drops older outcomes as new ones arrive', () => {
  const gate = new SpeculationGate({ ...options, cooldownMs: 0 })
  gate.recordMiss(100)
  gate.recordMiss(200)
  gate.recordMiss(300)
  gate.recordHit(400) // [F, F, F, T] -> 0.25 < 0.5
  assert.equal(gate.shouldSpeculate(500), false)

  gate.recordHit(600) // [F, F, T, T] -> 0.5 >= 0.5
  assert.equal(gate.shouldSpeculate(700), true)
})

test('disabled gate never blocks speculation', () => {
  const gate = new SpeculationGate({ ...options, enabled: false })
  for (let i = 0; i < 20; i += 1) gate.recordMiss(1000 + i)
  assert.equal(gate.shouldSpeculate(2000), true)
})

test('reset clears all counters and reopens a tripped breaker', () => {
  const gate = new SpeculationGate(options)
  for (let i = 0; i < 4; i += 1) gate.recordMiss(1000 + i)
  assert.equal(gate.shouldSpeculate(2000), false)

  gate.reset()
  const cleared = gate.stats()
  assert.equal(cleared.hits, 0)
  assert.equal(cleared.misses, 0)
  assert.equal(cleared.windowSize, 0)
  assert.equal(cleared.pausedUntil, 0)
  assert.equal(gate.shouldSpeculate(2000), true)
})
