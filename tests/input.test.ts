import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSummarizationInput, fingerprintSummarizationInput } from '../src/engine/input.js'
import { FakeSession } from './fixtures/session.js'

test('includes the system head and every shadowed message, plus the tool set', () => {
  const tools = [{ name: 'shell' }]
  const session = new FakeSession('s1', { withSystemHead: true, tools })
  session.appendTurns(3, 100)

  const input = buildSummarizationInput(session, [1, 2])
  assert.deepEqual(input.tools, tools)
  assert.equal(input.messages.length, 3)
  assert.equal(input.messages[0]?.role, 'user')
  assert.equal((input.messages[1]?.content as any)[0].text, 'message 0')
})

test('omits the system head when the surface does not start with one', () => {
  const session = new FakeSession('s1')
  session.appendTurns(2, 100)
  const input = buildSummarizationInput(session, [0, 1])
  assert.equal(input.messages.length, 2)
  assert.equal(input.tools, undefined)
})

test('the fingerprint is stable while the conversation grows past the pinned span', () => {
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(3, 100)
  const envelope = { provider: 'p', model: 'm', maxTokens: 4096 }
  const before = fingerprintSummarizationInput(buildSummarizationInput(session, [1, 2]), envelope)

  session.appendTurns(4, 100)
  const after = fingerprintSummarizationInput(buildSummarizationInput(session, [1, 2]), envelope)

  assert.equal(before, after)
})

test('the fingerprint changes when the pinned span, tool set, or summarizer envelope changes', () => {
  const session = new FakeSession('s1', { withSystemHead: true })
  session.appendTurns(3, 100)
  const baseInput = buildSummarizationInput(session, [1, 2])
  const envA = { provider: 'p', model: 'm-1', maxTokens: 4096 }
  const envB = { provider: 'p', model: 'm-2', maxTokens: 4096 }
  const envC = { provider: 'p', model: 'm-1', maxTokens: 2048 }

  const fpBase = fingerprintSummarizationInput(baseInput, envA)
  assert.notEqual(fpBase, fingerprintSummarizationInput(buildSummarizationInput(session, [1, 2, 3]), envA))
  assert.notEqual(fpBase, fingerprintSummarizationInput({ ...baseInput, tools: [{ name: 'shell' }] }, envA))
  assert.notEqual(fpBase, fingerprintSummarizationInput(baseInput, envB))
  assert.notEqual(fpBase, fingerprintSummarizationInput(baseInput, envC))
})

test('the fingerprint is a stable sha256 hex digest', () => {
  const session = new FakeSession('s1')
  session.appendTurns(1, 100)
  const fingerprint = fingerprintSummarizationInput(buildSummarizationInput(session, [0]))
  assert.match(fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(fingerprint, fingerprintSummarizationInput(buildSummarizationInput(session, [0])))
})
