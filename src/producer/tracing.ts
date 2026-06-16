import {
  type AttributeValue,
  generateSpanId,
  SPAN_EVENT_TYPE,
  type SpanEvent,
  type SpanException,
  type SpanKind,
} from '../protocol/index.js'

export interface SpanOptions {
  kind: SpanKind
  attributes?: Record<string, AttributeValue>
}

/**
 * Trace identifiers carried by a logger.
 *
 * `span_id` is the id of the span this logger is currently bound to. A root
 * logger created by `createLogger` is not yet bound to any span; its `span_id`
 * is `undefined`. Once `logger.withSpan(...)` runs, the child logger inside is
 * bound to a real span and its `span_id` is defined — see {@link ChildTraceContext}.
 *
 * `parent_span_id` is the upstream span this trace continues (across services,
 * via inbound `traceparent`). For root loggers with no inbound trace it's
 * `undefined`; for loggers inside `runSpan` it's the outer logger's `span_id`
 * (or, if the outer was a root logger with no bound span, the outer's
 * `parent_span_id` — i.e. the upstream service's span).
 *
 * `sampled` is decided once at the trace root and inherited unchanged by every
 * descendant span. The tail worker uses it to decide whether to forward spans
 * to Axiom's traces store; logs/metrics/errors are always forwarded regardless.
 */
export interface TraceContext {
  readonly trace_id: string
  readonly span_id: string | undefined
  readonly parent_span_id: string | undefined
  readonly sampled: boolean
}

/**
 * Trace identifiers for a logger bound to a span created inside `runSpan`.
 * Always has a real `span_id`.
 */
export interface ChildTraceContext extends TraceContext {
  readonly span_id: string
}

/**
 * Outcome passed to `SpanHandle.end`. Both fields are optional:
 *
 * - omit `error` for success; pass it for failure (matched against
 *   `isExpectedError` to decide `status: ok` vs `status: error`).
 * - `attributes` are merged onto the span's attributes, overriding any set at
 *   span creation on key collision. Use this for outcome-shaped attributes the
 *   caller only knows at settle time — e.g. `{ aborted: true }` to mark a
 *   cancelled span so dashboards can distinguish it from completion.
 */
export interface SpanExit {
  error?: unknown
  attributes?: Record<string, AttributeValue>
}

/** Handle for a span whose lifetime is driven by external callbacks. */
export interface SpanHandle {
  /** Trace identifiers for the span. Use to build a child logger. */
  readonly trace: ChildTraceContext
  /**
   * Emit the span event. Idempotent — second and later calls are ignored, so
   * racing callbacks (e.g. `onError` after `onAbort`) settle deterministically
   * on first-write-wins.
   */
  end(exit?: SpanExit): void
}

/**
 * Monotonic-anchored wall clock for span timing.
 *
 * Span timestamps come from a single anchor captured at root-logger creation:
 * `unixMsAtAnchor` (Date.now() at anchor time) plus elapsed `performance.now()`
 * since the anchor. This preserves sub-ms ordering within a request and avoids
 * drift if Date.now() jumps mid-request (rare on Workers, but free to guard).
 *
 * Cross-service clock skew is not addressed — Workers in different colos may
 * have small wall-clock differences. Tracing UIs tolerate this; it's not
 * fixable from inside the worker.
 */
export interface Clock {
  /** Returns the current time as Unix epoch nanoseconds (string, no precision loss). */
  nowUnixNano(): string
}

export interface StartSpanInput {
  parent: TraceContext
  resource: { service: string; environment: string | undefined }
  name: string
  options: SpanOptions
  clock: Clock
  isExpectedError?: (err: unknown) => boolean
  /** Invoked with the unexpected error once `end({ tag: 'error', error })` runs. */
  onUnexpectedError?: (err: unknown, child: ChildTraceContext) => void
}

export interface RunSpanInput<T> extends StartSpanInput {
  fn: (child: ChildTraceContext) => Promise<T>
}

export function createClock(): Clock {
  const unixMsAtAnchor = Date.now()
  const perfAtAnchor = performanceNow()

  return {
    nowUnixNano(): string {
      const elapsedMs = performanceNow() - perfAtAnchor
      const unixMs = unixMsAtAnchor + elapsedMs
      return BigInt(Math.trunc(unixMs * 1_000_000)).toString()
    },
  }
}

/**
 * Open a span whose lifetime is settled later by `handle.end(exit)`. Use when
 * the span's duration doesn't align with a function scope — for example a span
 * driven by streaming callbacks (`onFinish` / `onError` / `onAbort`).
 *
 * For function-scoped work prefer `runSpan` (or `logger.withSpan`), which can't
 * leak because the function boundary settles the span automatically.
 */
export function startSpan(input: StartSpanInput): SpanHandle {
  const { parent, resource, name, options, clock, isExpectedError, onUnexpectedError } = input
  const child: ChildTraceContext = {
    trace_id: parent.trace_id,
    span_id: generateSpanId(),
    parent_span_id: parent.span_id ?? parent.parent_span_id,
    sampled: parent.sampled,
  }

  const startTimeUnixNano = clock.nowUnixNano()
  const base = { ...child, ...resource, name, kind: options.kind }

  let settled = false
  return {
    trace: child,
    end(exit: SpanExit = {}): void {
      if (settled) return
      settled = true
      const endTimeUnixNano = clock.nowUnixNano()
      const attributes =
        exit.attributes !== undefined
          ? { ...options.attributes, ...exit.attributes }
          : options.attributes

      if (exit.error === undefined) {
        emitSpan({ ...base, attributes, status: 'ok', startTimeUnixNano, endTimeUnixNano })
        return
      }

      const expected = isExpectedError?.(exit.error) === true
      const exception = expected ? undefined : toSpanException(exit.error)
      emitSpan({
        ...base,
        attributes,
        status: expected ? 'ok' : 'error',
        statusMessage: exception?.message,
        exception,
        startTimeUnixNano,
        endTimeUnixNano,
      })
      if (!expected) onUnexpectedError?.(exit.error, child)
    },
  }
}

/**
 * Run an async function inside a span. Emits a SpanEvent on completion (success
 * or failure). Errors matched by `isExpectedError` are recorded as `status: 'ok'`
 * but still re-thrown — they're expected user-facing failures, not span failures.
 *
 * Thin wrapper over `startSpan` for the common case where the span's lifetime
 * aligns with a function call.
 */
export async function runSpan<T>(input: RunSpanInput<T>): Promise<T> {
  const { fn, ...rest } = input
  const handle = startSpan(rest)
  try {
    const result = await fn(handle.trace)
    handle.end()
    return result
  } catch (err) {
    handle.end({ error: err })
    throw err
  }
}

/**
 * Build the OTel-shaped exception info from any thrown value. Field names
 * (`type`, `message`, `stacktrace`, `escaped`) match OTel semantic conventions
 * so the tail worker can map them directly to OTLP `exception.*` attributes.
 */
export function toSpanException(err: unknown): SpanException {
  if (err instanceof Error) {
    return {
      type: err.name,
      message: err.message,
      stacktrace: err.stack,
      escaped: true,
    }
  }
  return { message: serializeUnknown(err), escaped: true }
}

function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function emitSpan(input: Omit<SpanEvent, 'type'>): void {
  if (input.environment === 'development') return
  const event: SpanEvent = { type: SPAN_EVENT_TYPE, ...input }
  console.log(JSON.stringify(event))
}

function serializeUnknown(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}
