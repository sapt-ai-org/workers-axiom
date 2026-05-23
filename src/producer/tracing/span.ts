import {
  type AttributeValue,
  generateSpanId,
  SPAN_EVENT_TYPE,
  type SpanEvent,
  type SpanException,
  type SpanKind,
} from '../../protocol/index.js'
import type { Clock } from './clock.js'

export interface SpanOptions {
  kind: SpanKind
  attributes?: Record<string, AttributeValue>
}

/**
 * Trace identifiers carried by a logger.
 *
 * `span_id` is the id of the span this logger is currently bound to. A root
 * logger created by `createLogger` is not yet bound to any span; its `span_id`
 * is `undefined`. Once `logger.span(...)` runs, the child logger inside is
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
 * Tagged outcome of a span's lifetime. Callers settle a span with one of these
 * tags so success / failure / cancellation each have a first-class encoding —
 * no overloading of return values vs thrown exceptions, no "the error path is
 * implicit." Borrowed from Effect's `Exit` shape.
 *
 * - `ok` — work completed successfully; carries the result value.
 * - `error` — work failed; carries the thrown value. `isExpectedError` decides
 *   whether the span records `status: error` or `status: ok` (expected user-facing
 *   failures like `SaptError` shouldn't pollute error dashboards).
 * - `aborted` — work was cancelled (e.g. user clicked stop, client disconnected).
 *   Recorded as `status: ok` with a `span.aborted: true` attribute so dashboards
 *   can distinguish abandonment from completion without inflating error rates.
 */
export type Exit<T> =
  | { tag: 'ok'; value: T }
  | { tag: 'error'; error: unknown }
  | { tag: 'aborted' }

/** Handle for a span whose lifetime is driven by external callbacks. */
export interface SpanHandle {
  /** Trace identifiers for the span. Use to build a child logger. */
  readonly trace: ChildTraceContext
  /**
   * Emit the span event. Idempotent — second and later calls are ignored, so
   * racing callbacks (e.g. `onError` after `onAbort`) settle deterministically
   * on first-write-wins.
   */
  end(exit: Exit<unknown>): void
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
  const base = {
    ...child,
    ...resource,
    name,
    kind: options.kind,
  }

  let settled = false
  return {
    trace: child,
    end(exit: Exit<unknown>): void {
      if (settled) return
      settled = true
      const endTimeUnixNano = clock.nowUnixNano()

      if (exit.tag === 'ok') {
        emitSpan({
          ...base,
          attributes: options.attributes,
          status: 'ok',
          startTimeUnixNano,
          endTimeUnixNano,
        })
        return
      }

      if (exit.tag === 'aborted') {
        emitSpan({
          ...base,
          attributes: { ...options.attributes, 'span.aborted': true },
          status: 'ok',
          startTimeUnixNano,
          endTimeUnixNano,
        })
        return
      }

      // tag === 'error'
      const expected = isExpectedError?.(exit.error) === true
      const exception = expected ? undefined : toSpanException(exit.error)
      emitSpan({
        ...base,
        attributes: options.attributes,
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

export interface RunSpanInput<T> extends StartSpanInput {
  fn: (child: ChildTraceContext) => Promise<T>
}

/**
 * Run an async function inside a span. Emits a SpanEvent on completion (success or
 * failure). Errors matched by `isExpectedError` are recorded as `status: 'ok'` but
 * still re-thrown — they're expected user-facing failures, not span failures.
 *
 * Thin wrapper over `startSpan` for the common case where the span's lifetime
 * aligns with a function call.
 */
export async function runSpan<T>(input: RunSpanInput<T>): Promise<T> {
  const { fn, ...rest } = input
  const handle = startSpan(rest)
  try {
    const result = await fn(handle.trace)
    handle.end({ tag: 'ok', value: result })
    return result
  } catch (err) {
    handle.end({ tag: 'error', error: err })
    throw err
  }
}

function emitSpan(input: Omit<SpanEvent, 'type'>): void {
  if (input.environment === 'development') return
  const event: SpanEvent = { type: SPAN_EVENT_TYPE, ...input }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event))
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

function serializeUnknown(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return JSON.stringify({
      ...value,
      name: value.name,
      message: value.message,
      stack: value.stack,
    })
  }
  try {
    return JSON.stringify(value)
  } catch {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value)
    }
    if (typeof value === 'symbol') return value.toString()
    if (typeof value === 'function') return '[function]'
    return '[unserializable]'
  }
}
