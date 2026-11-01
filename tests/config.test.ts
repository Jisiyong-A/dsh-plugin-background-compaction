import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_BACKGROUND_CONFIG, pickBaseConfig, resolveBackgroundConfig } from '../src/engine/config.js'
import { PLUGIN_VERSION } from '../src/version.js'

test('PLUGIN_VERSION stays synchronized with package.json', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test('pickBaseConfig forwards only keys the base class validates', () => {
  const picked = pickBaseConfig({
    thresholdRatio: 0.5,
    auto: false,
    headroomTokens: 100,
    enabled: true,
    debounceMs: 10,
    notARealKey: 1,
  })
  assert.deepEqual(picked, { thresholdRatio: 0.5, auto: false, headroomTokens: 100 })
})

test('pickBaseConfig forwards headroomTokens: 0 verbatim (P1-6 regression)', () => {
  // Base `resolveConfig` permits `headroomTokens: 0` whenever `maxTokens` is positive;
  // silently dropping `0` previously reverted headroom back to the stock 65536 default.
  const picked = pickBaseConfig({ headroomTokens: 0, maxTokens: 4096, thresholdRatio: 0.5 })
  assert.deepEqual(picked, { headroomTokens: 0, maxTokens: 4096, thresholdRatio: 0.5 })
})

test('pickBaseConfig tolerates missing, undefined and non-object config', () => {
  assert.deepEqual(pickBaseConfig(undefined), {})
  assert.deepEqual(pickBaseConfig({ thresholdRatio: undefined }), {})
  assert.deepEqual(pickBaseConfig({ retainTokens: null }), { retainTokens: null })
})

test('no background option can leak into the base config', () => {
  const picked = pickBaseConfig({ ...DEFAULT_BACKGROUND_CONFIG } as unknown as Record<string, unknown>)
  assert.deepEqual(picked, {})
})

test('resolveBackgroundConfig applies defaults and freezes the result', () => {
  const config = resolveBackgroundConfig(undefined)
  assert.equal(config.precomputeAtRatio, DEFAULT_BACKGROUND_CONFIG.precomputeAtRatio)
  assert.equal(config.maxConcurrent, DEFAULT_BACKGROUND_CONFIG.maxConcurrent)
  assert.equal(config.gateWindow, DEFAULT_BACKGROUND_CONFIG.gateWindow)
  assert.equal(config.gateMinHitRate, DEFAULT_BACKGROUND_CONFIG.gateMinHitRate)
  assert.equal(config.gateCooldownMs, DEFAULT_BACKGROUND_CONFIG.gateCooldownMs)
  assert.ok(Object.isFrozen(config))
})

test('resolveBackgroundConfig rejects wrong types and out-of-range values', () => {
  assert.throws(() => resolveBackgroundConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveBackgroundConfig({ precomputeAtRatio: 1.5 }), /precomputeAtRatio must be a number/)
  assert.throws(() => resolveBackgroundConfig({ heldTtlMs: 0 }), /heldTtlMs must be a number/)
  assert.throws(() => resolveBackgroundConfig({ gateWindow: 0 }), /gateWindow must be a number/)
  assert.throws(() => resolveBackgroundConfig({ gateMinHitRate: -0.1 }), /gateMinHitRate must be a number/)
  assert.throws(() => resolveBackgroundConfig({ gateMinHitRate: 1.1 }), /gateMinHitRate must be a number/)
  assert.throws(() => resolveBackgroundConfig({ gateCooldownMs: -1 }), /gateCooldownMs must be a number/)
})

test('resolveBackgroundConfig floors integer-valued options', () => {
  const config = resolveBackgroundConfig({
    debounceMs: 12.9,
    maxSessions: 3.7,
    maxConcurrent: 2.2,
    gateWindow: 4.8,
  })
  assert.equal(config.debounceMs, 12)
  assert.equal(config.maxSessions, 3)
  assert.equal(config.maxConcurrent, 2)
  assert.equal(config.gateWindow, 4)
})
