// Measure one benchmark arm from its persisted session log.
//
// The DSH compaction contract wraps every commit in a `compaction/start` …
// `compaction/end` pair carrying the same `compactionId`. Because the stock
// engine appends `compaction/start` BEFORE it builds the summarization input and
// calls the model, `end.time - start.time` is the wall-clock time the user is
// blocked inside compaction — the metric this benchmark is built around.
//
// Usage:
//   node benchmark/measure.mjs <session.v4.jsonl.zstd> [--json]
//   node benchmark/measure.mjs --types <session.v4.jsonl.zstd>

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** A DSH session file is a concatenation of independent zstd frames. */
export function decodeSessionFrames(buf) {
  const starts = []
  for (let i = 0; i <= buf.length - MAGIC.length; i += 1) {
    if (
      buf[i] === MAGIC[0] &&
      buf[i + 1] === MAGIC[1] &&
      buf[i + 2] === MAGIC[2] &&
      buf[i + 3] === MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  const chunks = []
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      chunks.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // A truncated trailing frame is expected while a session is live.
    }
  }
  return chunks.join('')
}

export function readRecords(file) {
  const text = decodeSessionFrames(readFileSync(file))
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // Partial trailing line from a live session.
    }
  }
  return records
}

function sizeOf(value) {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return Buffer.byteLength(value)
  return Buffer.byteLength(JSON.stringify(value))
}

/** Locate the assistant/user payload size of a record, for checkpoint sizing. */
function payloadSize(record) {
  const data = record.data ?? {}
  return Math.max(sizeOf(data.message), sizeOf(data.text), sizeOf(data.content), sizeOf(data))
}

/** Pull a provider usage sample out of a record, wherever the harness put it. */
function usageOf(record) {
  const data = record.data ?? {}
  const candidates = [data.usage, data.response?.usage, data.result?.usage, data.assistant?.usage]
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof (c.totalTokens ?? c.inputTokens) === 'number') return c
  }
  return undefined
}

export function measure(records) {
  const starts = new Map()
  const transactions = []

  for (const record of records) {
    if (record.type === 'compaction/start') {
      starts.set(record.data?.compactionId, record)
      continue
    }
    if (record.type !== 'compaction/end') continue
    const id = record.data?.compactionId
    const start = starts.get(id)
    if (!start) continue
    starts.delete(id)
    transactions.push({
      compactionId: id,
      turn: record.data?.turn,
      startTime: start.time,
      endTime: record.time,
      blockingMs: record.time - start.time,
      errored: record.data?.error !== undefined && record.data?.error !== null,
      error: record.data?.error,
    })
  }

  // A start with no end is an aborted transaction (process exit or throw).
  const aborted = [...starts.values()].map((record) => ({
    compactionId: record.data?.compactionId,
    turn: record.data?.turn,
    startTime: record.time,
  }))

  // Attach the summary and checkpoint sizes that were committed in each transaction.
  for (const tx of transactions) {
    const idx = records.findIndex(
      (r) => r.type === 'compaction/end' && r.data?.compactionId === tx.compactionId,
    )
    if (idx < 0) continue
    const window = records.slice(Math.max(0, idx - 6), idx)
    const summary = window.find((r) => r.type === 'compaction/summary')
    const checkpoint = window
      .filter((r) => r.type === 'user/message')
      .map(payloadSize)
      .sort((a, b) => b - a)[0]
    tx.summaryBytes = summary ? payloadSize(summary) : 0
    tx.checkpointBytes = checkpoint ?? 0
  }

  const usages = []
  for (const record of records) {
    const usage = usageOf(record)
    if (usage) usages.push({ seq: record.seq, time: record.time, ...usage })
  }

  const timed = records.filter((r) => typeof r.time === 'number')
  const first = timed[0]
  const last = timed[timed.length - 1]
  const totalBlockingMs = transactions.reduce((acc, tx) => acc + tx.blockingMs, 0)
  const peakBlockingMs = transactions.reduce((acc, tx) => Math.max(acc, tx.blockingMs), 0)
  const baselineTotal = usages.length ? (usages[0].totalTokens ?? 0) : 0
  const finalTotal = usages.length ? (usages[usages.length - 1].totalTokens ?? 0) : 0
  const peakTotal = usages.reduce((acc, u) => Math.max(acc, u.totalTokens ?? 0), 0)
  const sumInput = usages.reduce((acc, u) => acc + (u.inputTokens ?? 0), 0)
  const sumCached = usages.reduce((acc, u) => acc + (u.cachedInputTokens ?? u.cacheReadTokens ?? 0), 0)
  const sumOutput = usages.reduce((acc, u) => acc + (u.outputTokens ?? 0), 0)

  return {
    records: records.length,
    wallClockMs: first && last ? last.time - first.time : 0,
    transactions: transactions.length,
    abortedTransactions: aborted.length,
    totalBlockingMs,
    peakBlockingMs,
    transactionsDetail: transactions,
    abortedDetail: aborted,
    providerSamples: usages.length,
    baselineTotalTokens: baselineTotal,
    finalTotalTokens: finalTotal,
    peakTotalTokens: peakTotal,
    sumInputTokens: sumInput,
    sumCachedTokens: sumCached,
    sumOutputTokens: sumOutput,
  }
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : n
}

export function report(metrics) {
  const lines = []
  lines.push(`records ${fmt(metrics.records)} | wall clock ${(metrics.wallClockMs / 1000).toFixed(1)}s`)
  lines.push(
    `compaction transactions ${metrics.transactions} (aborted ${metrics.abortedTransactions})`,
  )
  lines.push(
    `blocking latency: total ${fmt(metrics.totalBlockingMs)}ms | peak ${fmt(metrics.peakBlockingMs)}ms`,
  )
  for (const tx of metrics.transactionsDetail) {
    lines.push(
      `  turn ${tx.turn} ${tx.compactionId?.slice(0, 8)}: ${fmt(tx.blockingMs)}ms, summary ${fmt(tx.summaryBytes)}B, checkpoint ${fmt(tx.checkpointBytes)}B${tx.errored ? ' [ERRORED]' : ''}`,
    )
  }
  for (const tx of metrics.abortedDetail) {
    lines.push(`  aborted ${tx.compactionId?.slice(0, 8)} (turn ${tx.turn}) — no compaction/end`)
  }
  lines.push(
    `provider tokens: baseline ${fmt(metrics.baselineTotalTokens)} | peak ${fmt(metrics.peakTotalTokens)} | final ${fmt(metrics.finalTotalTokens)}`,
  )
  lines.push(
    `billed tokens: input ${fmt(metrics.sumInputTokens)} | cached ${fmt(metrics.sumCachedTokens)} | output ${fmt(metrics.sumOutputTokens)}`,
  )
  return lines.join('\n')
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) {
  const args = process.argv.slice(2)
  const typesMode = args.includes('--types')
  const jsonMode = args.includes('--json')
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) {
    console.error('usage: node benchmark/measure.mjs <session.v4.jsonl.zstd> [--json|--types]')
    process.exit(2)
  }
  const records = readRecords(file)
  if (typesMode) {
    const counts = new Map()
    for (const r of records) counts.set(r.type, (counts.get(r.type) ?? 0) + 1)
    for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(n).padStart(4)}  ${type}`)
    }
    const withUsage = records.filter((r) => usageOf(r))
    console.log(`\nrecords carrying provider usage: ${withUsage.length}`)
    if (withUsage.length) console.log(JSON.stringify(withUsage[0], null, 2).slice(0, 900))
    process.exit(0)
  }
  const metrics = measure(records)
  console.log(jsonMode ? JSON.stringify(metrics, null, 2) : report(metrics))
}
