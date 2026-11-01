import { build } from 'esbuild'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(join(root, 'lib'), { recursive: true, force: true })
await mkdir(join(root, 'lib'), { recursive: true })

// Host-supplied `@deepseek-ai/*` packages stay external so `dsh-app-boot` (`routeLinked`)
// resolves them against the running app.asar copy via `peerDependencies`.
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  format: 'esm',
  bundle: true,
  platform: 'node',
  target: ['node20'],
  sourcemap: true,
  external: ['@deepseek-ai/*', 'node:*'],
  banner: {
    js: `// dsh-plugin-background-compaction v${pkg.version} - MIT`,
  },
})

execSync('pnpm exec tsc --emitDeclarationOnly --outDir lib', { cwd: root, stdio: 'inherit' })

console.log(`[build] built dsh-plugin-background-compaction v${pkg.version} (ESM + .d.ts)`)
