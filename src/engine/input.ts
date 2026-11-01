/**
 * Summarization-input construction and fingerprinting.
 *
 * Mirrors `buildSummarizationInput` (`dsh-compaction-basic/lib/index.js:695-704`) and
 * hashes the exact payload plus the effective summarizer target (`provider`, `model`,
 * `maxTokens`) so any drift in messages, tools, or summarization model invalidates a
 * held entry cleanly.
 */

import { createHash } from 'node:crypto'

import type { DshMessage, SessionLike, SummarizationInput } from '@deepseek-ai/dsh-compaction-basic'

import type { SummarizerEnvelope } from './spec.js'

/** Bump when the hashed envelope shape changes. */
const FINGERPRINT_VERSION = 'bgc-v2'

/** True when surface node 0 is the `system/message` head the base class keeps out of the shadowed range. */
function systemHeadSeq(session: SessionLike): number | undefined {
  const first = session.surface.nodes[0]
  if (first === undefined) return undefined
  try {
    return session.eventAt(first).type === 'system/message' ? first : undefined
  } catch {
    return undefined
  }
}

/**
 * Rebuild the summarizer payload for an explicit set of surface seqs.
 *
 * Mirrors `dsh-compaction-basic` verbatim so a fingerprint computed during background
 * precomputation matches the payload constructed by `compactRegion()` at commit time.
 */
export function buildSummarizationInput(session: SessionLike, shadowedSeqs: readonly number[]): SummarizationInput {
  const head = systemHeadSeq(session)
  const system = head === undefined ? null : session.deriveEventMessage(session.eventAt(head))
  const regionMessages: DshMessage[] = []
  for (const seq of shadowedSeqs) {
    const message = session.deriveEventMessage(session.eventAt(seq))
    if (message !== null) regionMessages.push(message)
  }
  const tools = session.requestHeader()?.tools
  return {
    ...(tools === undefined ? {} : { tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

/**
 * Stable SHA-256 content hash of a summarizer payload and its target model envelope.
 */
export function fingerprintSummarizationInput(
  input: SummarizationInput,
  summarizer?: SummarizerEnvelope,
): string {
  const payload = JSON.stringify({
    v: FINGERPRINT_VERSION,
    summarizer: summarizer ?? null,
    tools: input.tools ?? null,
    messages: input.messages,
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
