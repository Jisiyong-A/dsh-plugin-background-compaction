import { build } from 'esbuild'
import { readdir, mkdir, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = join(root, 'tests')
const outDir = join(root, 'dist-tests')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const testFiles = (await readdir(testsDir)).filter((f) => f.endsWith('.test.ts')).sort()
const bundledFiles = []

// DSH runtime packages are host-supplied (`peerDependencies` + `.npmrc`). Tests alias
// them to independent, contract-faithful doubles of `dsh-compaction(-basic)` 0.2.1-rc.5.
const alias = {
  '@deepseek-ai/dsh-compaction-basic': join(testsDir, 'fixtures/fake-compaction-basic.ts'),
  '@deepseek-ai/dsh-compaction': join(testsDir, 'fixtures/fake-compaction.ts'),
}

for (const file of testFiles) {
  const outPath = join(outDir, file.replace(/\.ts$/, '.mjs'))
  bundledFiles.push(outPath)
  await build({
    entryPoints: [join(testsDir, file)],
    outfile: outPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    sourcemap: 'inline',
    alias,
    external: ['node:test', 'node:assert', 'node:assert/strict', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:events'],
  })
}

console.log(`[test-build] bundled ${testFiles.length} suites; running node --test`)

const runner = spawn(process.execPath, ['--test', ...bundledFiles], { cwd: root, stdio: 'inherit' })
runner.on('exit', (code, signal) => {
  if (signal !== null) process.exit(1)
  process.exit(code ?? 1)
})
