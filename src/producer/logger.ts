import {
  type AttributeValue,
  formatTraceparent,
  generateTraceId,
  parseTraceparent,
  type SpanKind,
  SUMMARY_PROPERTIES_TYPE,
} from '../protocol/index.js'
import { type KVLike, type LogLevel, resolveLogLevel, shouldEmit } from './log-level.js'
import {
  type Clock,
  createClock,
  runSpan,
  type SpanExit,
  type SpanOptions,
  startSpan,
  toSpanException,
  type TraceContext,
} from './tracing.js'

export { LogLevel, type KVLike } from './log-level.js'

/**
 * Bag of correlation fields (requestId, actorId, etc.). Has no semantic meaning
 * to the logger — it's just merged into emitted JSON. First-class metadata
 * (`service`, `environment`, trace IDs) lives on the logger directly, not here.
 */
export type LogContext = Record<string, unknown>

export interface Logger {
  /** OTel `service.name`. */
  readonly service: string
  /** OTel `deployment.environment`, if set. */
  readonly environment: string | undefined
  readonly context: Readonly<LogContext>
  readonly trace: TraceContext
  /** Emit a `debug` log if the current level allows. */
  debug(message: string): void
  /** Emit an `info` log if the current level allows. */
  info(message: string): void
  /** Emit a `warn` log if the current level allows. */
  warn(message: string): void
  /**
   * Emit an `error` log. The thrown value is rendered into an OTel-shaped
   * `exception` field when it's an `Error`; otherwise serialized into `message`.
   */
  error(error: unknown, message?: string): void
  /** Emit a metric event. Suppressed when `environment === 'development'`. */
  metric(event: string, data?: Record<string, unknown>): void
  /**
   * Emit fields the tail worker should merge onto this invocation's
   * `invocation_summary` event. Use for cross-cutting correlation fields
   * (`requestId`, `trace_id`, identity, etc.) that should appear on the
   * per-invocation summary regardless of which log/metric also carried them.
   *
   * Last-write-wins on collision per invocation in the tail worker.
   */
  summary(properties: Record<string, unknown>): void
  /** Extend the correlation context. Returns a new logger sharing trace state. */
  child(context: LogContext): Logger
  /**
   * Run an async function inside a new span. The child logger passed to `fn`
   * has the new span's traceId/spanId bound, so any logs/metrics emitted
   * inside automatically correlate with the span.
   *
   * Errors thrown by `fn` are recorded on the span and re-thrown unchanged.
   * Errors matched by the `isExpectedError` predicate (configured at logger
   * creation) are recorded as `status: 'ok'` — they're expected user-facing
   * failures, not span failures.
   */
  withSpan<T>(name: string, options: SpanOptions, fn: (logger: Logger) => Promise<T>): Promise<T>
  /**
   * Open a span whose lifetime is settled later. Use when the span's duration
   * doesn't align with a function scope (typically driven by external
   * callbacks like a streaming API's `onFinish`/`onError`/`onAbort`).
   *
   * Returns a handle bundling a `Logger` already bound to the new span (so
   * logs/metrics emitted via it correlate automatically) and an `end(exit?)`
   * method that settles the span. `end` is idempotent — first call wins, later
   * calls are ignored.
   *
   * Prefer `withSpan` when the span's lifetime aligns with a function — that
   * form can't leak.
   */
  startSpan(name: string, options: SpanOptions): LoggerSpanHandle
  /**
   * Returns headers to propagate the current trace context on outbound calls.
   * Always include the result on outbound `fetch` calls (including service
   * bindings) to maintain a single distributed trace across services.
   */
  tracingHeaders(): Headers
}

/** Handle returned by `Logger.startSpan` — span-bound logger plus `end(exit?)`. */
export interface LoggerSpanHandle {
  /** Child logger bound to the new span; pass into work that should correlate. */
  readonly logger: Logger
  /** Settle the span. Idempotent: first call wins. */
  end(exit?: SpanExit): void
}

export interface LoggerOptions {
  /**
   * Logical service name. Required on every logger because OpenTelemetry
   * mandates `service.name` on every span; loggers without it would produce
   * spans tagged `unknown_service` by collectors.
   */
  service: string
  /**
   * Deployment environment. Maps to OTel `deployment.environment` on spans.
   * When set to `'development'`, metrics are suppressed and logs are
   * pretty-printed instead of emitted as JSON.
   */
  environment?: string
  /**
   * Explicit log level. Used as the fallback when `kv` is also provided but
   * doesn't contain a valid level. Defaults to `'info'`.
   */
  level?: LogLevel
  /** Additional correlation fields (requestId, etc.). */
  context?: LogContext
  /**
   * Predicate identifying expected/business errors that should not mark spans
   * as failed. Typical use: `(err) => err instanceof MyExpectedError`. The
   * library stays domain-free; the predicate is the explicit contract.
   */
  isExpectedError?: (err: unknown) => boolean
  /**
   * Inbound headers carrying `traceparent`. When present, the logger continues
   * the inbound trace; otherwise it starts a fresh one. Pass at HTTP entrypoints.
   */
  headers?: Headers
  /**
   * Probability (0..1) of sampling a freshly minted trace. The verdict is
   * decided once at the trace root, propagated to all descendants via
   * `traceparent`, and stamped onto every emitted record. Inbound traces
   * inherit the upstream verdict and ignore this. Defaults to 1 (sample all).
   *
   * Logs/metrics/errors are always forwarded regardless — only span forwarding
   * to Axiom's traces store is gated by the verdict.
   */
  sampleRate?: number
  /**
   * KV namespace for log-level lookup. When set, the logger reads `logLevel`
   * (or `logLevel:{logLevelKey}` if a suffix is provided) from KV and uses
   * that level if valid; otherwise falls back to `level`. Forced to `'debug'`
   * in development.
   */
  kv?: KVLike
  /** Optional KV key suffix; looks up `logLevel:{logLevelKey}` instead of `logLevel`. */
  logLevelKey?: string
}

export interface WithTraceOptions extends LoggerOptions {
  /** Span name. Use the entrypoint's logical operation, e.g. `api.fetch`, `scheduled.tick`. */
  name: string
  /** Span kind. Defaults to `'server'`. Use `'consumer'` for queue/cron. */
  kind?: SpanKind
  /** Attributes to attach to the root span. */
  attributes?: Record<string, AttributeValue>
}

/**
 * Create a new logger. If `options.headers` carries a `traceparent`, the trace
 * is continued; otherwise a fresh trace starts.
 *
 * Async because the log level may be resolved from KV. If `options.kv` is
 * omitted, no I/O happens but the function is still async for shape consistency.
 *
 * Most entrypoints should use `withTrace` instead, which calls `createLogger`
 * and wraps the handler in a root span. `createLogger` is the right primitive
 * only when there's no enclosing async scope to open a span around.
 */
export async function createLogger(options: LoggerOptions): Promise<Logger> {
  const level = await resolveLogLevel(options)
  const incoming = options.headers
    ? parseTraceparent(options.headers.get('traceparent'))
    : undefined
  const sampled = incoming?.sampled ?? Math.random() < (options.sampleRate ?? 1)
  return buildLogger({ ...options, level }, createClock(), {
    trace_id: incoming?.trace_id ?? generateTraceId(),
    span_id: undefined,
    parent_span_id: incoming?.span_id,
    sampled,
  })
}

/**
 * Entrypoint helper: build a logger and wrap the handler in a root span in one
 * call. The root span is what local child spans (`logger.withSpan(...)`) parent
 * to, so without it those children are orphaned in the trace viewer.
 *
 * For HTTP entrypoints, pass `headers` to continue any inbound `traceparent`.
 * For queue/cron entrypoints, omit `headers` and the trace starts fresh.
 * Pass `kv` to resolve the log level from KV.
 */
export async function withTrace<T>(
  options: WithTraceOptions,
  fn: (logger: Logger) => Promise<T>,
  hooks?: { onError?: (err: unknown, logger: Logger) => T | Promise<T> }
): Promise<T> {
  const { name, kind = 'server', attributes, ...loggerOptions } = options
  const logger = await createLogger(loggerOptions)
  try {
    return await logger.withSpan(name, { kind, attributes }, fn)
  } catch (err) {
    if (hooks?.onError) {
      return await hooks.onError(err, logger)
    }
    throw err
  }
}

/** No-op logger for tests and environments where logging should be suppressed. */
export const noopLogger: Logger = {
  service: '',
  environment: undefined,
  context: {},
  trace: { trace_id: '', span_id: undefined, parent_span_id: undefined, sampled: false },
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  metric: () => {},
  summary: () => {},
  child: () => noopLogger,
  withSpan: <T>(_name: string, _options: SpanOptions, fn: (logger: Logger) => Promise<T>) =>
    fn(noopLogger),
  startSpan: () => ({ logger: noopLogger, end: () => {} }),
  tracingHeaders: () => new Headers(),
}

function buildLogger(options: LoggerOptions, clock: Clock, trace: TraceContext): Logger {
  const { service, environment, isExpectedError, level = 'info' } = options
  const context: LogContext = { ...options.context }

  const isDev = environment === 'development'

  const shouldLog = (logLevel: LogLevel): boolean => shouldEmit(logLevel, level)

  const emit = (entry: Record<string, unknown>) => {
    console.log(
      JSON.stringify({
        service,
        environment,
        ...context,
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        parent_span_id: trace.parent_span_id,
        sampled: trace.sampled,
        ...entry,
      })
    )
  }

  const log = (logLevel: LogLevel, message: string) => {
    if (!shouldLog(logLevel)) return
    if (isDev) {
      const levelTag = logLevel.toUpperCase().padEnd(5)
      console.log(`${levelTag} ${message}`)
    } else {
      emit({ type: 'log', level: logLevel, message })
    }
  }

  return {
    service,
    environment,
    context,
    trace,

    debug(message: string) {
      log('debug', message)
    },

    info(message: string) {
      log('info', message)
    },

    warn(message: string) {
      log('warn', message)
    },

    error(error: unknown, message?: string) {
      if (!shouldLog('error')) return
      const exception = error instanceof Error ? toSpanException(error) : undefined
      const body = message ?? (error instanceof Error ? error.message : String(error))
      if (isDev) {
        console.error(`ERROR ${body}${exception?.stacktrace ? `\n${exception.stacktrace}` : ''}`)
      } else {
        emit({ type: 'error', message: body, ...(exception !== undefined ? { exception } : {}) })
      }
    },

    metric(event: string, data?: Record<string, unknown>) {
      if (isDev) {
        console.info(`METRIC ${event}`)
        return
      }
      emit({ type: 'metric', event, ...data })
    },

    summary(properties: Record<string, unknown>) {
      if (isDev) return
      // Bypass `emit` so trace-context, service, environment, and inherited
      // context don't ride along. Summary records are invocation-scoped and
      // exist only to feed `invocation_summary` in the tail worker.
      console.log(JSON.stringify({ type: SUMMARY_PROPERTIES_TYPE, ...properties }))
    },

    child(newContext: LogContext): Logger {
      return buildLogger({ ...options, context: { ...context, ...newContext } }, clock, trace)
    },

    async withSpan<T>(
      name: string,
      spanOptions: SpanOptions,
      fn: (logger: Logger) => Promise<T>
    ): Promise<T> {
      return runSpan({
        parent: trace,
        resource: { service, environment },
        name,
        options: spanOptions,
        clock,
        isExpectedError,
        fn: (childCtx) => fn(buildLogger(options, clock, childCtx)),
        onUnexpectedError: (err, childCtx) =>
          buildLogger(options, clock, childCtx).error(err, `span "${name}" failed`),
      })
    },

    startSpan(name: string, spanOptions: SpanOptions): LoggerSpanHandle {
      const handle = startSpan({
        parent: trace,
        resource: { service, environment },
        name,
        options: spanOptions,
        clock,
        isExpectedError,
        onUnexpectedError: (err, childCtx) =>
          buildLogger(options, clock, childCtx).error(err, `span "${name}" failed`),
      })
      return {
        logger: buildLogger(options, clock, handle.trace),
        end: handle.end,
      }
    },

    tracingHeaders(): Headers {
      const headers = new Headers()
      if (trace.span_id !== undefined) {
        headers.set('traceparent', formatTraceparent(trace.trace_id, trace.span_id, trace.sampled))
      }
      return headers
    },
  }
}
