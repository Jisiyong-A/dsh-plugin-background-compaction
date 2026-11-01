// Deterministic benchmark fixtures.
//
// Generates N markdown documents of near-identical size. Each document ends with
// three "recorded constants" whose values are unique per document. The benchmark
// task asks for the constants of the FIRST document after every document has been
// read, so the run measures two things at once:
//
//   1. how much context the arm needs to carry, and
//   2. whether whichever compaction strategy ran still preserved the exact
//      identifiers from the earliest, most-likely-to-be-compacted span.
//
// Seeded PRNG so every run compares against byte-identical input.

import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'fixtures')

/** xorshift32 — deterministic, no dependency. */
function makeRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

const TOPICS = [
  'Ingest Gateway',
  'Shard Rebalancer',
  'Write-Ahead Log',
  'Snapshot Compactor',
  'Query Planner',
  'Replica Follower',
  'Lease Coordinator',
  'Index Builder',
  'Cache Warmer',
  'Dead Letter Queue',
  'Schema Migrator',
  'Backpressure Valve',
  'Clock Skew Monitor',
  'Tombstone Sweeper',
  'Fragment Merger',
  'Consistency Auditor',
]

const PARAGRAPHS = [
  'The component is deployed as a single-writer process per shard, pinned to a NUMA node so that its allocation path never crosses a socket boundary. Operators scale it horizontally by adding shards, never by adding replicas of the same shard, because the write path assumes a single owner. Ownership is granted through the lease coordinator and is revocable within two heartbeat intervals, which bounds the worst-case period during which two processes may believe they own the same shard.',
  'Backpressure is applied at the ingress boundary rather than inside the component. When the downstream queue exceeds eighty percent of its configured high-water mark, the ingress path switches from rejecting individual requests to shedding a proportional slice of the traffic, so that clients observe a smooth degradation curve instead of a cliff. The shedding decision is made per tenant with a weighted fair queue, which prevents a single high-volume tenant from consuming the entire allowance during an incident.',
  'Durability is provided by an append-only segment log. Each segment is fsynced before its records are acknowledged, and segments are sealed at a fixed size so that recovery can replay them in parallel. Recovery is bounded by a checkpoint that records the last flushed offset together with a digest of the preceding log, so a partially written tail is detected and discarded rather than replayed. Checkpoints are written atomically through a rename, which means a crash either leaves the previous checkpoint intact or leaves the new one complete.',
  'Reads are served from an in-memory structure that mirrors the log up to the most recent checkpoint plus a replay window. When a reader requests an offset older than the retention horizon, the request is answered from cold storage through a compacted segment index. That index is rebuilt incrementally during periods of low write activity, and the rebuild is resumable: if the process restarts halfway through, it continues from the last durable index offset instead of starting over.',
  'Observability is deliberately coarse. The component exports counters for accepted, rejected, shed and failed operations, plus a histogram of end-to-end latency sampled at one in a hundred requests. It does not export per-key metrics, because the cardinality would exceed what the metrics backend can reasonably store. Traces are sampled adaptively: the sampler keeps every error, keeps a fixed fraction of slow requests, and keeps a small uniform sample of everything else, which keeps the tracing budget predictable regardless of traffic shape.',
  'Configuration is validated at startup and then frozen for the lifetime of the process. Parameters that operators genuinely need to change at runtime are exposed through a narrow control plane with explicit semantics, and every mutation is appended to an audit log before it takes effect. Everything else requires a restart, which is treated as an acceptable cost because the component is designed to be restarted quickly and to lose no acknowledged work.',
  'Failure handling distinguishes between transient and terminal conditions. Transient conditions are retried with exponential backoff and jitter, capped at a maximum interval that is derived from the lease duration rather than hard-coded. Terminal conditions surface immediately to the caller with a structured error that names the invariant that was violated, so that an operator reading the log does not have to reconstruct what went wrong from a stack trace.',
  'Resource accounting is explicit. Every allocation larger than a fixed threshold is attributed to the requesting tenant, and the component enforces a per-tenant memory ceiling by refusing work rather than by triggering the global out-of-memory handler. The threshold is chosen so that steady-state operation never crosses it, which means the accounting path itself stays off the hot path in normal conditions.',
]

function hex(rng, n) {
  let s = ''
  for (let i = 0; i < n; i += 1) s += Math.floor(rng() * 16).toString(16)
  return s
}

function buildDocument(index, rng, targetBytes) {
  const topic = TOPICS[index % TOPICS.length]
  const header = `# Document ${String(index + 1).padStart(2, '0')}: ${topic}\n\n`
  const footer = [
    '',
    '## Recorded constants',
    '',
    `- SERVICE_TOKEN_${String(index + 1).padStart(2, '0')}: TKN-${hex(rng, 8).toUpperCase()}`,
    `- LISTEN_PORT_${String(index + 1).padStart(2, '0')}: ${20000 + Math.floor(rng() * 40000)}`,
    `- RETENTION_DAYS_${String(index + 1).padStart(2, '0')}: ${3 + Math.floor(rng() * 90)}`,
    '',
  ].join('\n')

  const body = [header]
  let size = Buffer.byteLength(header) + Buffer.byteLength(footer)
  let p = index
  while (size < targetBytes) {
    const para = PARAGRAPHS[p % PARAGRAPHS.length]
    body.push(para, '\n\n')
    size += Buffer.byteLength(para) + 2
    p += 1
  }
  return body.join('') + footer
}

const count = Number(process.argv[2] ?? 16)
const targetBytes = Number(process.argv[3] ?? 6000)
const rng = makeRng(0x5eed1234)

mkdirSync(OUT, { recursive: true })

const manifest = []
for (let i = 0; i < count; i += 1) {
  const text = buildDocument(i, rng, targetBytes)
  const file = `doc-${String(i + 1).padStart(2, '0')}.md`
  writeFileSync(join(OUT, file), text, 'utf8')
  const constants = text
    .split('## Recorded constants')[1]
    .trim()
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean)
  manifest.push({ file, bytes: Buffer.byteLength(text), constants })
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const total = readdirSync(OUT)
  .filter((f) => f.endsWith('.md'))
  .reduce((acc, f) => acc + statSync(join(OUT, f)).size, 0)

console.log(`generated ${manifest.length} documents, ${total} bytes total (~${Math.round(total / 4)} tokens of raw text)`)
console.log(`first document constants: ${manifest[0].constants.join(' | ')}`)
