// Aggregate the four arms into the comparison table that ships in the README.
//
// Repeated runs (`node benchmark/run-arm.mjs a b c d --rep 2`) land in
// `results/<arm>-rN.json`; the first pass lands in `results/<arm>.json`. Both are
// picked up here and reduced to a median, because a single sample of a
// network-bound measurement is not a benchmark.
//
// Usage:
//   node benchmark/report.mjs           # markdown
//   node benchmark/report.mjs --json    # raw metrics, all reps

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'results')
const ARMS = ['a', 'b', 'c', 'd']

const SHORT = {
  a: 'A — stock `compaction-basic`',
  b: 'B — `tool-result-pruner` + `compaction-basic`',
  c: 'C — `dsh-dcp` (deterministic, zero-LLM)',
  d: 'D — `background-compaction` (this plugin)',
}

function loadReps(arm) {
  if (!existsSync(RESULTS)) return []
  const pattern = new RegExp(`^${arm}(-r(\\d+))?\\.json$`)
  const reps = []
  for (const name of readdirSync(RESULTS)) {
    const match = name.match(pattern)
    if (!match) continue
    const data = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
    if (data.failed) continue
    reps.push({ rep: Number(match[2] ?? 1), data })
  }
  reps.sort((x, y) => x.rep - y.rep)
  return reps
}

const rows = ARMS.map((arm) => ({ arm, reps: loadReps(arm) }))
const available = rows.filter((r) => r.reps.length > 0)
if (available.length === 0) {
  console.error('no results yet - run node benchmark/run-arm.mjs first')
  process.exit(2)
}

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      Object.fromEntries(available.map((r) => [r.arm, r.reps.map((x) => x.data)])),
      null,
      2,
    ),
  )
  process.exit(0)
}

const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—')
const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const sec = (ms) => (median(ms) === undefined ? '—' : (median(ms) / 1000).toFixed(1))

function summarise(reps) {
  const m = reps.map((r) => r.data.metrics)
  return {
    samples: reps.length,
    transactions: median(m.map((x) => x.transactions)),
    blockingTotalSec: sec(m.map((x) => x.totalBlockingMs)),
    blockingPeakSec: sec(m.map((x) => x.peakBlockingMs)),
    peakCtx: median(m.map((x) => x.peakTotalTokens)),
    finalCtx: median(m.map((x) => x.finalTotalTokens)),
    input: median(m.map((x) => x.sumInputTokens)),
    cached: median(m.map((x) => x.sumCachedTokens)),
    output: median(m.map((x) => x.sumOutputTokens)),
    wallSec: (median(reps.map((r) => r.data.elapsedMs)) / 1000).toFixed(1),
    fidelityPass: reps.every((r) => r.data.fidelity.survived === r.data.fidelity.total),
    fidelity: reps.map((r) => `${r.data.fidelity.survived}/${r.data.fidelity.total}`).join(' '),
  }
}

const table = [
  '| arm | strategy | compactions | blocking (median) | worst single | peak ctx | final ctx | billed in / cached / out | kept | n |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: |',
]
for (const { arm, reps } of available) {
  const s = summarise(reps)
  table.push(
    `| ${arm.toUpperCase()} | ${SHORT[arm]} | ${n(s.transactions)} | ${s.blockingTotalSec} s | ${s.blockingPeakSec} s | ${n(s.peakCtx)} | ${n(s.finalCtx)} | ${n(s.input)} / ${n(s.cached)} / ${n(s.output)} | ${s.fidelity} | ${s.samples} |`,
  )
}
console.log(table.join('\n'))

console.log('\n### per-run detail\n')
for (const { arm, reps } of available) {
  for (const { rep, data } of reps) {
    const m = data.metrics
    console.log(
      `**${arm.toUpperCase()} rep ${rep}** — session \`${data.session}\`, exit ${data.exitCode}, wall ${(data.elapsedMs / 1000).toFixed(1)} s, fidelity ${data.fidelity.survived}/${data.fidelity.total}`,
    )
    if (m.transactionsDetail.length === 0) console.log('  - no compaction transaction was recorded')
    for (const tx of m.transactionsDetail) {
      console.log(
        `  - turn ${tx.turn}: blocked ${n(tx.blockingMs)} ms, summary ${n(tx.summaryBytes)} B, checkpoint ${n(tx.checkpointBytes)} B${tx.errored ? ' (errored)' : ''}`,
      )
    }
    for (const tx of m.abortedDetail) {
      console.log(`  - aborted ${String(tx.compactionId).slice(0, 8)} (turn ${tx.turn}): no \`compaction/end\``)
    }
    console.log('')
  }
}
