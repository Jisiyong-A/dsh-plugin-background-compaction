import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSummarizationInput } from '../src/engine/input.js'
import { selectPrecomputeRange } from '../src/engine/span.js'
import { resolveCompactSpec, resolveTargetPolicy } from '../src/engine/spec.js'
import {
  baseResolvePolicy,
  baseSelectRange,
  buildBaseInput,
  resolveBaseConfig,
} from './fixtures/fake-compaction-basic.js'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from './fixtures/fake-compaction.js'
import { FakeSession, resetPairingOverrides, unbalancedAfter, unbalancedBefore } from './fixtures/session.js'

const guard = {
  balancedBefore: toolPairingBalancedBefore,
  balancedAfter: toolPairingBalancedAfter,
}

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

test('parity: resolveTargetPolicy matches base policy resolution across overrides and retention modes', () => {
  const resolved = resolveBaseConfig({
    thresholdRatio: 0.75,
    headroomTokens: 4096,
    retainTokens: 2500,
    maxTokens: 2048,
    modelPolicies: [
      {
        provider: 'p-1',
        model: 'm-1',
        thresholdRatio: 0.6,
        retainRatio: 0.12,
        summarizationProvider: 'sum-p',
        summarizationModel: 'sum-m',
      },
      {
        provider: 'p-2',
        model: 'm-2',
        headroomTokens: 0,
        maxTokens: 1024,
      },
    ],
  })

  for (const target of [
    { provider: 'p-1', model: 'm-1' },
    { provider: 'p-2', model: 'm-2' },
    { provider: 'other', model: 'other' },
  ]) {
    assert.deepEqual(resolveTargetPolicy(resolved as any, target), baseResolvePolicy(resolved, target))
  }
})

test('parity: resolveCompactSpec matches base threshold and retention math', () => {
  const resolved = resolveBaseConfig({
    thresholdRatio: 0.8,
    headroomTokens: 8192,
    retainRatio: 0.16,
    modelPolicies: [
      { provider: 'fake-provider', model: 'fake-model', thresholdRatio: 0.65, headroomTokens: 1024, retainRatio: 0.1 },
    ],
  })
  const session = new FakeSession('s-parity', { maxTokens: 4096 })
  const target = { provider: 'fake-provider', model: 'fake-model' }
  const spec = resolveCompactSpec(resolved as any, target, { context: { contextWindow: 60_000 } }, session)

  // Base math: messageBudget = 60000 - 4096 = 55904; pressureBudget = 55904 - 1024 = 54880;
  // threshold = floor(min(60000 * 0.65, 54880)) = 39000; retain = floor(55904 * 0.1) = 5590.
  assert.deepEqual(spec, {
    provider: 'fake-provider',
    model: 'fake-model',
    contextWindow: 60_000,
    thresholdTokens: 39_000,
    retainTokens: 5_590,
  })
})

test('parity: selectPrecomputeRange and buildSummarizationInput match base selection across pairing cuts', () => {
  for (const withSystemHead of [false, true]) {
    for (const retainTokens of [0, 500, 1500, 3000]) {
      resetPairingOverrides()
      const session = new FakeSession('s-parity', {
        withSystemHead,
        tools: withSystemHead ? [{ name: 'bash' }] : undefined,
      })
      session.appendTurns(8, 600)
      unbalancedBefore.add(6)

      const m = measure(session)
      const baseRange = baseSelectRange(session, m, retainTokens)
      const pluginRange = selectPrecomputeRange(session, m, retainTokens, guard)

      if (baseRange === null) {
        assert.equal(pluginRange, null)
      } else {
        assert.ok(pluginRange !== null)
        assert.equal(pluginRange.start, baseRange.start)
        assert.equal(pluginRange.end, baseRange.end)
        assert.deepEqual(
          buildSummarizationInput(session, pluginRange.seqs),
          buildBaseInput(session, pluginRange.seqs),
        )
      }
    }
  }

  // When baseSelectRange picks an end boundary that violates toolPairingBalancedAfter,
  // base `validateSurfaceRegion` rejects it at commit time; `selectPrecomputeRange`
  // rejects it proactively before wasting a speculative LLM call.
  resetPairingOverrides()
  const session = new FakeSession('s-end-cut', { withSystemHead: true })
  session.appendTurns(5, 1000)
  unbalancedAfter.add(3)
  assert.equal(selectPrecomputeRange(session, measure(session), 1500, guard), null)
  resetPairingOverrides()
})
