/**
 * `dsh-plugin-background-compaction` entry point.
 *
 * DSH mounts a single `ctx.compaction` service per context from the package default
 * export. Mount it in place of `compaction-basic` via the bundled `cordis.patch.yml`.
 */

import { BackgroundCompactionEngine } from './engine/engine.js'
import { DEFAULT_BACKGROUND_CONFIG, type BackgroundCompactionOptions } from './engine/config.js'
import type { SpeculationStats } from './engine/gate.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.js'

export { BackgroundCompactionEngine, DEFAULT_BACKGROUND_CONFIG, PLUGIN_NAME, PLUGIN_VERSION }
export type { BackgroundCompactionOptions, SpeculationStats }

export default BackgroundCompactionEngine
