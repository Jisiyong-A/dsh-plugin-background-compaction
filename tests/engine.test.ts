import test from 'node:test'
import assert from 'node:assert/strict'

import { BackgroundCompactionEngine } from '../src/engine/engine.js'
import { FakeSession, resetPairingOverrides } from './fixtures/session.js'

/** A context shaped like the slice of Cordis the engine touches. */
function makeContext() {
  const listeners = new Map<string, (...args: any[]) => any>()
  const disposers: Array<() => void> = []
  let contextWindow = 10_000
  let summaryTokenEstimate = 200
  let pruner: { pruneSession(session: FakeSession): void } | undefined

  return {
    listeners,
    disposers,
    setContextWindow(value: number) {
      contextWindow = value
    },
    setSummaryTokenEstimate(value: number) {
      summaryTokenEstimate = value
    },
    setToolResultPruner(impl: { pruneSession(session: FakeSession): void } | undefined) {
      pruner = impl
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    tokenMeter: {
      measure(session: FakeSession) {
        return {
          nodes: session.nodes.map((seq) => ({
            seq,
            tokens: session.tokensAt(seq),
            heuristicTokens: session.tokensAt(seq),
          })),
          totalTokens: session.totalTokens,
        }
      },
      estimateMessage() {
        return summaryTokenEstimate
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow } }
      },
    },
    sessions: { async flush() {} },
    get(name: string) {
      if (name === 'toolResultPruner') return pruner
      return undefined
    },
    on(event: string, listener: (...args: any[]) => any) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback: () => void | (() => void)) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
  }
}

/** Poll until a condition settles. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for background precompute')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Engine config with explicit base options matching a 10_000-token test window:
 * threshold = 8000, watermark = 5760, retain = 1000.
 */
const engineConfig = {
  thresholdRatio: 0.8,
  headroomTokens: 0,
  retainRatio: 0.1,
  maxTokens: 1024,
  precomputeAtRatio: 0.72,
  minShadowTokens: 100,
  heldTtlMs: 60_000,
  debounceMs: 0,
  maxConcurrent: 1,
  maxSessions: 8,
  gateEnabled: false,
  trace: false,
}

function makeSession(turns: number, options: { withSystemHead?: boolean } = { withSystemHead: true }) {
  resetPairingOverrides()
  const session = new FakeSession('session-1', options)
  session.appendTurns(turns, 1000)
  return session
}

function mount(config: Record<string, unknown> = engineConfig) {
  const ctx = makeContext()
  const engine = new BackgroundCompactionEngine(ctx as any, config)
  const emitPreStep = async (session: FakeSession) => {
    const handler = ctx.listeners.get('agent/pre-step')
    assert.ok(handler !== undefined, 'agent/pre-step must be bound')
    await handler({ agent: { session } }, () => undefined)
  }
  return { ctx, engine, emitPreStep }
}

test('mounts cleanly with stock base defaults when only background options are passed', () => {
  const ctx = makeContext()
  const engine = new BackgroundCompactionEngine(ctx as any, { precomputeAtRatio: 0.72 })
  assert.equal(engine.config.thresholdRatio, 0.8)
  assert.equal(engine.config.headroomTokens, 65536)
  assert.equal(engine.config.retainRatio, 0.16)
  assert.equal((engine.config as any).precomputeAtRatio, undefined)
})

test('does nothing below the precompute watermark', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(3) // 3500 tokens < 5760
  await emitPreStep(session)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.heldCount, 0)
})

test('precomputes a summary once the watermark is crossed', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7) // 7500 tokens, between 5760 and 8000
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  const calls = (engine as any).calls as Array<{ method: string }>
  assert.equal(calls.filter((call) => call.method === 'summarize').length, 1)
  assert.equal(calls.some((call) => call.method === 'compactRegion'), false)
})

test('skips precompute once the session is already at pressure', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(9) // 9500 tokens >= 8000
  await emitPreStep(session)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.heldCount, 0)
})

test('serves the held summary and commits the pinned span at pressure', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  session.appendTurns(2, 1000) // 9500 tokens >= 8000
  const result = await engine.compactIfNeeded({ session } as any, 'pressure')

  assert.ok(result !== null)
  const calls = (engine as any).calls as Array<{ method: string; detail: any }>
  const committed = calls.find((call) => call.method === 'compactRegion')
  assert.deepEqual(committed?.detail, { start: 1, end: 6 })
  assert.equal((engine as any).summarizeInputs.length, 1)
  assert.equal(engine.speculationStats.hits, 1)
  assert.equal(engine.heldCount, 0)
  assert.equal(session.totalTokens, 3700)
})

test('P0-1: modelPolicies without .target wrapper align watermark and threshold with base engine', async () => {
  const { engine, emitPreStep } = mount({
    ...engineConfig,
    thresholdRatio: 0.9, // would be 9000 without policy override
    modelPolicies: [
      {
        provider: 'fake-provider',
        model: 'fake-model',
        thresholdRatio: 0.6, // overridden threshold = 6000, watermark = 4320
        headroomTokens: 0,
        retainRatio: 0.1,
      },
    ],
  })
  const session = makeSession(4) // 4500 tokens: above 4320 watermark, below 6000 threshold
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  session.appendTurns(2, 1000) // 6500 tokens: >= 6000 policy threshold
  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.ok(result !== null)
  assert.equal(engine.speculationStats.hits, 1)
  assert.equal((engine as any).summarizeInputs.length, 1)
})

test('P0-2: delegates to super.compactIfNeeded when below threshold even while holding a summary', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7) // 7500 < 8000
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.equal(result, null)
  const calls = (engine as any).calls as Array<{ method: string }>
  assert.equal(calls.some((call) => call.method === 'compactIfNeeded'), true)
  // Held summary stays intact for when pressure is genuinely reached.
  assert.equal(engine.heldCount, 1)
})

test('P1-1: runs toolResultPruner before committing held summary and skips compaction when pruning suffices', async () => {
  const { ctx, engine, emitPreStep } = mount()
  const session = makeSession(7) // seqs 1..7; pinned span is 1..6 (tail seq 7 retained)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  session.appendTurns(2, 1000) // seqs 8, 9 -> 9500 >= 8000

  // Pruner trims tail node seq 8 from 1000t down to 100t and seq 9 down to 100t -> 7700 < 8000!
  // Because seqs 1..6 were untouched, the held summary stays valid for future turns.
  let pruned = false
  ctx.setToolResultPruner({
    pruneSession(target) {
      pruned = true
      target.pruneNode(8, 'pruned-8', 100)
      target.pruneNode(9, 'pruned-9', 100)
    },
  })

  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.equal(pruned, true)
  assert.equal(result, null)
  assert.equal(engine.heldCount, 1)
  assert.equal(engine.speculationStats.hits, 0)
  assert.equal(engine.speculationStats.misses, 0)
})

test('P1-2: payload drift delegates directly to base engine with only ONE foreground LLM call', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)
  assert.equal((engine as any).summarizeInputs.length, 1)

  // Mutate the tool set so the held fingerprint no longer matches, then add 2 turns.
  session.requestHeader = () =>
    ({ tools: [{ name: 'changed' }], config: { provider: 'fake-provider', model: 'fake-model' } }) as any
  session.appendTurns(2, 1000) // 9500 >= 8000

  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.ok(result !== null)
  assert.equal(engine.speculationStats.misses, 1)
  assert.equal(engine.speculationStats.hits, 0)
  assert.equal(engine.heldCount, 0)
  // Exactly 2 calls total: 1 speculative background call + 1 full-span foreground call (NOT 3!).
  assert.equal((engine as any).summarizeInputs.length, 2)
  assert.deepEqual(result.shadowedRange, { start: 1, end: 8 })
})

test('P1-3: books a miss (not a hit) when compactRegion rejects the held summary on shrink check', async () => {
  const { ctx, engine, emitPreStep } = mount()
  const session = makeSession(7)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  session.appendTurns(2, 1000)
  // First estimateMessage call (for held span 1..6 = 6000t) returns 7000t -> fails shrink check!
  // Fallback super.compactIfNeeded compacts 1..8 = 8000t, where 7000t < 8000t succeeds.
  ctx.setSummaryTokenEstimate(7000)

  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.ok(result !== null)
  assert.equal(engine.speculationStats.hits, 0)
  assert.equal(engine.speculationStats.misses, 1)
  assert.equal(engine.heldCount, 0)
  assert.deepEqual(result.shadowedRange, { start: 1, end: 8 })
})

test('P1-4: auto: false does not register background speculation listeners', () => {
  const { ctx } = mount({ ...engineConfig, auto: false })
  assert.equal(ctx.listeners.has('agent/pre-step'), false)
})

test('P1-5: maxConcurrent is enforced across async resolveModelInfo boundaries', async () => {
  const ctx = makeContext()
  let activeModelInfoCalls = 0
  let maxObservedConcurrent = 0
  ctx.llm.resolveModelInfo = async () => {
    activeModelInfoCalls += 1
    maxObservedConcurrent = Math.max(maxObservedConcurrent, activeModelInfoCalls)
    await new Promise((resolve) => setTimeout(resolve, 40))
    activeModelInfoCalls -= 1
    return { context: { contextWindow: 10_000 } }
  }

  const engine = new BackgroundCompactionEngine(ctx as any, { ...engineConfig, maxConcurrent: 1 })
  const handler = ctx.listeners.get('agent/pre-step')!
  const s1 = new FakeSession('s-1', { withSystemHead: true })
  s1.appendTurns(7, 1000)
  const s2 = new FakeSession('s-2', { withSystemHead: true })
  s2.appendTurns(7, 1000)

  await Promise.all([
    handler({ agent: { session: s1 } }, () => undefined),
    handler({ agent: { session: s2 } }, () => undefined),
  ])
  await until(() => engine.heldCount === 1)
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(maxObservedConcurrent, 1)
  assert.equal(engine.heldCount, 1)
})

test('P1-7: foreground compaction aborts an in-flight background precompute', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7)

  let backgroundSignal: AbortSignal | undefined
  ;(engine as any).summarizeImpl = async (_input: any, _agent: any, signal?: AbortSignal) => {
    if (backgroundSignal === undefined) {
      backgroundSignal = signal
      await new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
      })
    }
    return { summary: [{ type: 'text', text: 'fg-summary' }], provider: 'fake', model: 'fake' }
  }

  await emitPreStep(session)
  await until(() => backgroundSignal !== undefined)
  assert.equal(backgroundSignal!.aborted, false)

  // Push session over threshold and run foreground compaction while background is still streaming.
  session.appendTurns(2, 1000)
  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.ok(result !== null)
  assert.equal(backgroundSignal!.aborted, true)
  assert.equal(engine.heldCount, 0)
})

test('falls back to the base engine when the pinned span left the surface', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  session.replaceSpan(1, 6, 200)
  session.appendTurns(9, 1000)

  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.ok(result !== null)
  assert.equal(engine.heldCount, 0)
  assert.equal(engine.speculationStats.misses, 1)
  const calls = (engine as any).calls as Array<{ method: string }>
  assert.equal(calls.some((call) => call.method === 'compactIfNeeded'), true)
})

test('context-overflow after conversation growth drops invalidated held summary', async () => {
  const { engine, emitPreStep } = mount()
  const session = makeSession(7) // precomputes 1..6
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  session.appendTurns(2, 1000) // overflow now selects 1..8 != 1..6
  const result = await engine.compactIfNeeded({ session } as any, 'context-overflow')
  assert.ok(result !== null)
  assert.equal(engine.heldCount, 0)
  assert.equal(engine.speculationStats.misses, 1)
  assert.equal(engine.speculationStats.hits, 0)
})

test('compactNow reuses an exact-matching held summary and books a miss if commit rejects', async () => {
  const { ctx, engine, emitPreStep } = mount()
  const session = makeSession(7) // retainTokens=1000 selects 1..6, identical to compactNow's retainTokens=0
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  const result = await engine.compactNow({ session } as any, new AbortController().signal)
  assert.ok(result !== null)
  assert.equal((engine as any).summarizeInputs.length, 1) // 0 foreground LLM calls!
  assert.equal(engine.speculationStats.hits, 1)

  // Now verify post-commit accounting when compactNow's shrink check rejects the summary:
  const s2 = new FakeSession('session-2', { withSystemHead: true })
  s2.appendTurns(7, 1000)
  await emitPreStep(s2)
  await until(() => engine.heldCount === 1)
  ctx.setSummaryTokenEstimate(99_999)
  await assert.rejects(
    () => engine.compactNow({ session: s2 } as any, new AbortController().signal),
    /summary is not smaller/,
  )
  assert.equal(engine.speculationStats.hits, 1) // unchanged!
  assert.equal(engine.speculationStats.misses, 1)
})

test('expired held summaries are booked as misses even when schedulePrecompute peeks first', async () => {
  const { engine, emitPreStep } = mount({ ...engineConfig, heldTtlMs: 1_000 })
  const session = makeSession(7)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)

  // Force expiry by waiting slightly over 1s, then trigger another pre-step.
  await new Promise((resolve) => setTimeout(resolve, 1050))
  await emitPreStep(session)
  await until(() => engine.speculationStats.misses === 1 && engine.heldCount === 1)
  assert.equal(engine.speculationStats.misses, 1)
})

test('a disabled engine behaves identically to the base engine', async () => {
  const { engine, ctx } = mount({ ...engineConfig, enabled: false })
  const session = makeSession(9)
  assert.equal(ctx.listeners.has('agent/pre-step'), false)
  const result = await engine.compactIfNeeded({ session } as any, 'pressure')
  assert.ok(result !== null)
  assert.equal(engine.heldCount, 0)
  assert.equal(engine.speculationStats.hits, 0)
})

test('dispose and Cordis fiber teardown detach listeners, abort work, and never call non-existent super.dispose()', async () => {
  const { engine, ctx, emitPreStep } = mount()
  const session = makeSession(7)
  await emitPreStep(session)
  await until(() => engine.heldCount === 1)
  assert.equal(ctx.listeners.has('agent/pre-step'), true)

  engine.dispose()
  assert.equal(engine.heldCount, 0)
  assert.equal(ctx.listeners.has('agent/pre-step'), false)
  // Idempotent across both manual dispose() and Cordis fiber effect disposer.
  engine.dispose()
  assert.equal(ctx.disposers.length, 1)
  ctx.disposers[0]!()
})
