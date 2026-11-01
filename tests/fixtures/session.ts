/**
 * Test double for the event-sourced DSH session.
 *
 * Models the read seams `BasicCompactionEngine` consumes: the append-only surface node
 * list, per-node route pricing through the meter, durable message derivation by seq,
 * and replacement folding.
 */

/** One record in the fake durable log. */
export interface FakeEvent {
  type: string
  seq: number
  data?: Record<string, unknown>
  /** Message this event derives, as `deriveEventMessage` would return. */
  message?: { role: string; content: Array<{ type: string; text: string }> } | null
}

/** Session double exposing the same read seams `BasicCompactionEngine` uses. */
export class FakeSession {
  readonly id: string
  seq = 0
  readonly surface: { nodes: number[] } = { nodes: [] }
  private readonly events = new Map<number, FakeEvent>()
  private readonly pricing = new Map<number, number>()
  private readonly tools: unknown
  private maxTokens: number | undefined

  constructor(
    id: string,
    options: { withSystemHead?: boolean; tools?: unknown; maxTokens?: number } = {},
  ) {
    this.id = id
    this.tools = options.tools
    this.maxTokens = options.maxTokens
    if (options.withSystemHead === true) this.append('system/message', 'system prompt', 500)
  }

  /** Append one message node and return its seq. */
  append(type: string, text: string, tokens: number): number {
    const seq = this.seq
    this.seq += 1
    const role = type === 'assistant/message' ? 'assistant' : 'user'
    this.events.set(seq, {
      type,
      seq,
      message: { role, content: [{ type: 'text', text }] },
    })
    this.pricing.set(seq, tokens)
    this.surface.nodes.push(seq)
    return seq
  }

  /** Append `count` user/assistant turns of `tokens` each. */
  appendTurns(count: number, tokens: number): void {
    for (let index = 0; index < count; index += 1) {
      this.append(index % 2 === 0 ? 'user/message' : 'assistant/message', `message ${index}`, tokens)
    }
  }

  /** Mutate an existing node's text and token price (simulates tool-result pruning). */
  pruneNode(seq: number, newText: string, newTokens: number): void {
    const existing = this.events.get(seq)
    if (existing === undefined) throw new Error(`fake session: no event at seq ${seq}`)
    this.events.set(seq, {
      ...existing,
      message: {
        role: existing.message?.role ?? 'user',
        content: [{ type: 'text', text: newText }],
      },
    })
    this.pricing.set(seq, newTokens)
  }

  /** Look up a durable event by seq. */
  eventAt(seq: number): FakeEvent {
    const event = this.events.get(seq)
    if (event === undefined) throw new Error(`fake session: no event at seq ${seq}`)
    return event
  }

  /** Derive the replayable message for an event. */
  deriveEventMessage(event: FakeEvent) {
    return event.message ?? null
  }

  /** The routed request envelope recorded for the latest request. */
  requestHeader() {
    return {
      ...(this.tools === undefined ? {} : { tools: this.tools }),
      config: {
        provider: 'fake-provider',
        model: 'fake-model',
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
      },
    }
  }

  /** Route-priced tokens for `seq`. */
  tokensAt(seq: number): number {
    return this.pricing.get(seq) ?? 0
  }

  /** Sum of route-priced tokens over the current surface. */
  get totalTokens(): number {
    let total = 0
    for (const seq of this.surface.nodes) total += this.tokensAt(seq)
    return total
  }

  /** Current surface node list. */
  get nodes(): number[] {
    return this.surface.nodes
  }

  /** Replace an inclusive surface span with a single summary node. */
  replaceSpan(start: number, end: number, summaryTokens: number): number {
    const from = this.surface.nodes.indexOf(start)
    const to = this.surface.nodes.indexOf(end)
    if (from < 0 || to < 0 || to < from) {
      throw new Error('fake session: replaceSpan on a span outside the surface')
    }
    const summarySeq = this.seq
    this.seq += 1
    this.events.set(summarySeq, {
      type: 'user/message',
      seq: summarySeq,
      message: { role: 'user', content: [{ type: 'text', text: 'summary' }] },
    })
    this.pricing.set(summarySeq, summaryTokens)
    this.surface.nodes.splice(from, to - from + 1, summarySeq)
    return summarySeq
  }
}

/** Surface positions where `toolPairingBalancedBefore` must return false. */
export const unbalancedBefore = new Set<number>()

/** Surface positions where `toolPairingBalancedAfter` must return false. */
export const unbalancedAfter = new Set<number>()

/** Clear every pairing override between tests. */
export function resetPairingOverrides(): void {
  unbalancedBefore.clear()
  unbalancedAfter.clear()
}
