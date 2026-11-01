import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveCompactSpec,
  resolveSpecForAgent,
  resolveSummarizerEnvelope,
  resolveTargetPolicy,
  routedTarget,
} from '../src/engine/spec.js'
import { FakeSession } from './fixtures/session.js'

/** Base config shaped identically to `BasicCompactionEngine.resolveConfig()` output. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    thresholdRatio: 0.8,
    headroomTokens: 0,
    retainRatio: 0.1,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 1024,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    modelPolicies: [],
    auto: true,
    ...overrides,
  } as any
}

test('resolves the routed target from the request header', () => {
  const session = new FakeSession('s1')
  assert.deepEqual(routedTarget(session), { provider: 'fake-provider', model: 'fake-model' })
})

test('reports no target when the header has no routing', () => {
  const session = new FakeSession('s1')
  session.requestHeader = () => ({ config: { provider: '', model: 'x' } }) as any
  assert.equal(routedTarget(session), null)
})

test('threshold is the window ratio, not the message budget, when headroom is small', () => {
  const session = new FakeSession('s1')
  const spec = resolveCompactSpec(
    config(),
    routedTarget(session)!,
    { context: { contextWindow: 100_000 } } as any,
    session,
  )
  assert.ok(spec !== null)
  assert.equal(spec.thresholdTokens, 80_000)
  assert.equal(spec.retainTokens, 10_000)
})

test('threshold is clamped by the pressure budget', () => {
  const session = new FakeSession('s1', { maxTokens: 2000 })
  const spec = resolveCompactSpec(
    config({ headroomTokens: 3000 }),
    { provider: 'fake-provider', model: 'fake-model' },
    { context: { contextWindow: 10_000 } } as any,
    session,
  )
  assert.ok(spec !== null)
  // messageBudget 8000 - headroom 3000 = 5000, below window * 0.8 = 8000
  assert.equal(spec.thresholdTokens, 5000)
})

test('an explicit retainTokens form wins over retainRatio', () => {
  const session = new FakeSession('s1')
  const spec = resolveCompactSpec(
    config({ retainTokens: 4000 }),
    routedTarget(session)!,
    { context: { contextWindow: 100_000 } } as any,
    session,
  )
  assert.ok(spec !== null)
  assert.equal(spec.retainTokens, 4000)
})

test('top-level provider/model in modelPolicies overrides defaults (P0-1 regression)', () => {
  const session = new FakeSession('s1')
  const policyConfig = config({
    modelPolicies: [
      {
        provider: 'fake-provider',
        model: 'fake-model',
        thresholdRatio: 0.5,
        headroomTokens: 0,
        retainRatio: 0.02,
        summarizationProvider: 'sum-provider',
        summarizationModel: 'sum-model',
        maxTokens: 512,
      },
    ],
  })
  const merged = resolveTargetPolicy(policyConfig, routedTarget(session)!)
  assert.equal(merged.thresholdRatio, 0.5)
  assert.equal(merged.retainRatio, 0.02)
  assert.equal(merged.summarizationProvider, 'sum-provider')
  assert.equal(merged.summarizationModel, 'sum-model')
  assert.equal(merged.maxTokens, 512)

  const spec = resolveCompactSpec(
    policyConfig,
    routedTarget(session)!,
    { context: { contextWindow: 100_000 } } as any,
    session,
  )
  assert.ok(spec !== null)
  assert.equal(spec.thresholdTokens, 50_000)

  const envelope = resolveSummarizerEnvelope(policyConfig, { session })
  assert.deepEqual(envelope, { provider: 'sum-provider', model: 'sum-model', maxTokens: 512 })
})

test('a policy without retention inherits the resolved default form', () => {
  const merged = resolveTargetPolicy(
    config({
      retainTokens: 1234,
      modelPolicies: [{ provider: 'fake-provider', model: 'fake-model', thresholdRatio: 0.7 }],
    }),
    { provider: 'fake-provider', model: 'fake-model' },
  )
  assert.equal(merged.retainTokens, 1234)
  assert.equal(merged.retainRatio, undefined)
})

test('refuses targets with no usable capacity or invalid retention', () => {
  const session = new FakeSession('s1')
  const target = routedTarget(session)!
  assert.equal(resolveCompactSpec(config(), target, {} as any, session), null)
  assert.equal(resolveCompactSpec(config(), target, { context: { contextWindow: 0 } } as any, session), null)
  assert.equal(
    resolveCompactSpec(config({ headroomTokens: 20_000 }), target, { context: { contextWindow: 1000 } } as any, session),
    null,
  )
  assert.equal(
    resolveCompactSpec(config({ retainTokens: 90_000 }), target, { context: { contextWindow: 100_000 } } as any, session),
    null,
  )
})

test('resolveSpecForAgent asks the adapter for the routed target capacity', async () => {
  const session = new FakeSession('s1')
  const asked: string[] = []
  const llm = {
    async resolveModelInfo(provider: string, model: string) {
      asked.push(`${provider}/${model}`)
      return { context: { contextWindow: 50_000 } } as any
    },
  }
  const spec = await resolveSpecForAgent(config(), llm, { session } as any)
  assert.deepEqual(asked, ['fake-provider/fake-model'])
  assert.ok(spec !== null)
  assert.equal(spec.thresholdTokens, 40_000)
})
