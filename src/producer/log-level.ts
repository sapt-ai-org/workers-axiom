/**
 * Log-level types, KV-backed resolution, and the level-comparison primitive.
 *
 * The logger reads its threshold once at creation via {@link resolveLogLevel};
 * everything afterwards is a synchronous {@link shouldEmit} comparison against
 * the numeric ranks in {@link LogLevel}. KV is queried only when supplied, so
 * loggers without a `kv` binding pay no I/O cost.
 */

export const LogLevel = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const

export type LogLevel = keyof typeof LogLevel

/** Minimal subset of `KVNamespace` used for log-level lookup. */
export interface KVLike {
  get(key: string): Promise<string | null>
}

export interface ResolveLogLevelOptions {
  /** Forces `'debug'` when set to `'development'`, bypassing KV and `level`. */
  environment?: string
  /** KV namespace queried for a dynamic level override. */
  kv?: KVLike
  /** Optional KV key suffix; looks up `logLevel:{logLevelKey}` instead of `logLevel`. */
  logLevelKey?: string
  /** Fallback level when KV is absent or returns an invalid value. */
  level?: LogLevel
}

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LogLevel
}

/**
 * Resolve the active log level. Precedence:
 *
 * 1. `environment === 'development'` → forced `'debug'`.
 * 2. `kv.get('logLevel')` (or `logLevel:{logLevelKey}`) if it returns a valid level.
 * 3. Explicit `level`.
 * 4. `'info'`.
 */
export async function resolveLogLevel(opts: ResolveLogLevelOptions): Promise<LogLevel> {
  if (opts.environment === 'development') return 'debug'
  if (!opts.kv) return opts.level ?? 'info'
  const key = opts.logLevelKey ? `${BASE_LOG_LEVEL_KEY}:${opts.logLevelKey}` : BASE_LOG_LEVEL_KEY
  const value = await opts.kv.get(key)
  return isValidLogLevel(value) ? value : (opts.level ?? 'info')
}

/** Returns true when `candidate` is at or above the configured `threshold`. */
export function shouldEmit(candidate: LogLevel, threshold: LogLevel): boolean {
  return LogLevel[candidate] >= LogLevel[threshold]
}

const BASE_LOG_LEVEL_KEY = 'logLevel'
