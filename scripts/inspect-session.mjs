#!/usr/bin/env node
/**
 * Decode and profile a DSH session log.
 *
 *   node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [out.jsonl]
 *
 * `session.v4.jsonl.zstd` is a concatenation of independent zstd frames (one per
 * flush), so a single zstdDecompressSync() call returns only the first frame and
 * makes a live session look almost empty. This script walks the frame magic
 * bytes, decodes every frame, and prints:
 *
 *   - a record-type histogram
 *   - a chronological timeline with a running message-token estimate
 *   - the provider `usage` reported by each assistant turn
 *   - any `compaction/start` | `compaction/end` markers
 *
 * Used by the sandbox test described in SANDBOX-REPORT.md.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const file = process.argv[2]
const outFile = process.argv[3]

if (!file) {
  console.error('usage: node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [out.jsonl]')
  process.exit(1)
}

const buf = readFileSync(file)
const frameStarts = []
for (let i = 0; i < buf.length - 3; i++) {
  if (
    buf[i] === ZSTD_MAGIC[0] &&
    buf[i + 1] === ZSTD_MAGIC[1] &&
    buf[i + 2] === ZSTD_MAGIC[2] &&
    buf[i + 3] === ZSTD_MAGIC[3]
  ) {
    frameStarts.push(i)
  }
}

let text = ''
let decodedFrames = 0
for (let k = 0; k < frameStarts.length; k++) {
  const end = k + 1 < frameStarts.length ? frameStarts[k + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(frameStarts[k], end)).toString('utf8')
    decodedFrames++
  } catch {
    /* a torn tail frame is expected while a session is live */
  }
}
if (outFile) writeFileSync(outFile, text, 'utf8')

const records = text
  .split('\n')
  .filter(Boolean)
  .map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)

console.log(`frames: ${frameStarts.length} (decoded ${decodedFrames}), records: ${records.length}`)

const typeCounts = new Map()
for (const record of records) {
  const type = record.type ?? 'unknown'
  typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
}
console.log('\n=== record types ===')
for (const [type, count] of [...typeCounts].sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(6), type)
}

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])
let cumulativeBytes = 0
let sawCompaction = false

console.log('\n=== timeline ===')
for (const record of records) {
  const type = record.type ?? 'unknown'
  const data = record.data ?? {}
  const size = Buffer.byteLength(JSON.stringify(data), 'utf8')
  if (MESSAGE_TYPES.has(type)) cumulativeBytes += size
  if (type === 'compaction/start' || type === 'compaction/end') sawCompaction = true

  const detail =
    type === 'assistant/message'
      ? ` usage=${JSON.stringify(data.usage ?? null)}`
      : type === 'tool/call'
        ? ` ${data.name ?? ''}`
        : type === 'request/context'
          ? ` ${data.provider ?? ''}/${data.model ?? ''} window=${data.contextWindow ?? '?'}`
          : ''
  console.log(
    `${String(record.seq ?? '-').padStart(5)} ${type.padEnd(26)} ${String(size).padStart(7)}B` +
      ` cum=${String(cumulativeBytes).padStart(7)}B${detail}`
  )
}

console.log(`\nmessage payload bytes: ${cumulativeBytes} (~${Math.round(cumulativeBytes / 3.5)} tokens)`)
console.log(`compaction markers present: ${sawCompaction ? 'YES' : 'no'}`)
