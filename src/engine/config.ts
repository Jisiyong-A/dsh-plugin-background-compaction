/**
 * Configuration split for the background-compaction engine.
 *
 * The subclass shares one config object with `BasicCompactionEngine`, which validates
 * its own keys against a strict allowlist (`BASIC_COMPACT_CONFIG_KEYS` in
 * `dsh-compaction-basic/lib/index.js:31-35, 59-60`) and throws on unknown keys.
 * Because Cordis schemastery validation is non-strict (`merge(result, data)`), this
 * plugin's extra keys reach the constructor untouched. {@link pickBaseConfig} forwards
 * only base-class keys verbatim to `super()`, and {@link resolveBackgroundConfig}
 * validates the plugin's own options.
 */

/** Options consumed by this plugin only; never forwarded to `BasicCompactionEngine`. */
export interface BackgroundCompactionOptions {
  /** Master switch. When false the engine behaves identically to `compaction-basic`. */
  enabled: boolean
  /**
   * Fraction of the base engine's threshold at which background summarization starts.
   * Must be below 1 so the summary is ready before pressure triggers a foreground pass.
   */
  precomputeAtRatio: number
  /** Skip speculation when the span being shadowed is worth fewer tokens than this. */
  minShadowTokens: number
  /** Discard an unused held summary after this long (ms). */
  heldTtlMs: number
  /** Coalescing window for pre-step precompute triggers (ms). */
  debounceMs: number
  /** Maximum concurrent background summarization calls across all sessions. */
  maxConcurrent: number
  /** Maximum number of sessions holding a summary at once. */
  maxSessions: number
  /** Enable the sliding-window hit-rate circuit breaker. */
  gateEnabled: boolean
  /** Number of recent settled speculations evaluated by the circuit breaker. */
  gateWindow: number
  /** Minimum hit rate in `[0, 1]` over `gateWindow` required to keep speculating. */
  gateMinHitRate: number
  /** Cooldown pause (ms) when recent hit rate drops below `gateMinHitRate`. */
  gateCooldownMs: number
  /** Emit `[bgc]` diagnostic lines (via `ctx.logger` and stderr). */
  trace: boolean
}

/** Keys owned by `BasicCompactionEngine`; forwarded verbatim. */
const BASE_CONFIG_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
] as const

/** Defaults tuned for an interactive coding session. */
export const DEFAULT_BACKGROUND_CONFIG: Readonly<BackgroundCompactionOptions> = Object.freeze({
  enabled: true,
  precomputeAtRatio: 0.72,
  minShadowTokens: 2000,
  heldTtlMs: 300_000,
  debounceMs: 1_500,
  maxConcurrent: 1,
  maxSessions: 64,
  gateEnabled: true,
  gateWindow: 6,
  gateMinHitRate: 0.5,
  gateCooldownMs: 300_000,
  trace: false,
})

/**
 * Strip this plugin's own keys so `BasicCompactionEngine.resolveConfig()` only sees
 * the allowlisted set it validates. Every present base key (including `headroomTokens: 0`,
 * which the base allows when `maxTokens` is positive) is forwarded verbatim.
 */
export function pickBaseConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = config !== undefined && config !== null && typeof config === 'object' ? config : {}
  const picked: Record<string, unknown> = {}
  for (const key of BASE_CONFIG_KEYS) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) {
      picked[key] = source[key]
    }
  }
  return picked
}

/** Read, validate and freeze this plugin's own options. */
export function resolveBackgroundConfig(
  config: Record<string, unknown> | undefined,
): Readonly<BackgroundCompactionOptions> {
  const source = config !== undefined && config !== null && typeof config === 'object' ? config : {}
  const readBoolean = (key: string, fallback: boolean): boolean => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new TypeError(`BackgroundCompactionConfig: ${key} must be a boolean`)
    return value
  }
  const readNumber = (key: string, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new TypeError(`BackgroundCompactionConfig: ${key} must be a number in [${min}, ${max}]`)
    }
    return value
  }

  return Object.freeze({
    enabled: readBoolean('enabled', DEFAULT_BACKGROUND_CONFIG.enabled),
    precomputeAtRatio: readNumber('precomputeAtRatio', DEFAULT_BACKGROUND_CONFIG.precomputeAtRatio, 0.1, 0.99),
    minShadowTokens: Math.floor(readNumber('minShadowTokens', DEFAULT_BACKGROUND_CONFIG.minShadowTokens, 0, Number.MAX_SAFE_INTEGER)),
    heldTtlMs: Math.floor(readNumber('heldTtlMs', DEFAULT_BACKGROUND_CONFIG.heldTtlMs, 1_000, 86_400_000)),
    debounceMs: Math.floor(readNumber('debounceMs', DEFAULT_BACKGROUND_CONFIG.debounceMs, 0, 60_000)),
    maxConcurrent: Math.floor(readNumber('maxConcurrent', DEFAULT_BACKGROUND_CONFIG.maxConcurrent, 1, 16)),
    maxSessions: Math.floor(readNumber('maxSessions', DEFAULT_BACKGROUND_CONFIG.maxSessions, 1, 4096)),
    gateEnabled: readBoolean('gateEnabled', DEFAULT_BACKGROUND_CONFIG.gateEnabled),
    gateWindow: Math.floor(readNumber('gateWindow', DEFAULT_BACKGROUND_CONFIG.gateWindow, 1, 1000)),
    gateMinHitRate: readNumber('gateMinHitRate', DEFAULT_BACKGROUND_CONFIG.gateMinHitRate, 0, 1),
    gateCooldownMs: Math.floor(readNumber('gateCooldownMs', DEFAULT_BACKGROUND_CONFIG.gateCooldownMs, 0, 86_400_000)),
    trace: readBoolean('trace', DEFAULT_BACKGROUND_CONFIG.trace),
  })
}
