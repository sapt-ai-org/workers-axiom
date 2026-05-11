import {
  type AttributeValue,
  generateSpanId,
  SPAN_EVENT_TYPE,
  type SpanEvent,
  type SpanException,
  type SpanKind,
} from '../../protocol'
import type { Clock } from './clock'

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

export interface RunSpanInput<T> {
  parent: TraceContext
  resource: { service: string; environment: string | undefined }
  name: string
  options: SpanOptions
  clock: Clock
  isExpectedError?: (err: unknown) => boolean
  fn: (child: ChildTraceContext) => Promise<T>
  onUnexpectedError?: (err: unknown, child: ChildTraceContext) => void
}

/**
 * Run an async function inside a span. Emits a SpanEvent on completion (success or
 * failure). Errors matched by `isExpectedError` are recorded as `status: 'ok'` but
 * still re-thrown — they're expected user-facing failures, not span failures.
 */
export async function runSpan<T>(input: RunSpanInput<T>): Promise<T> {
  const { parent, resource, name, options, clock, isExpectedError, fn, onUnexpectedError } = input
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
    attributes: options.attributes,
  }

  try {
    const result = await fn(child)
    emitSpan({ ...base, status: 'ok', startTimeUnixNano, endTimeUnixNano: clock.nowUnixNano() })
    return result
  } catch (err) {
    const expected = isExpectedError?.(err) === true
    const exception = expected ? undefined : toSpanException(err)
    emitSpan({
      ...base,
      status: expected ? 'ok' : 'error',
      statusMessage: exception?.message,
      exception,
      startTimeUnixNano,
      endTimeUnixNano: clock.nowUnixNano(),
    })
    if (!expected) onUnexpectedError?.(err, child)
    throw err
  }
}

function emitSpan(input: Omit<SpanEvent, 'type'>): void {
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
