/**
 * Wire format shared by the producer (logger) and the tail-worker consumer.
 *
 * The producer emits JSON lines via `console.log`; the tail worker parses them
 * and forwards to Axiom. Both sides import these types so the format is
 * enforced by the type system rather than coordinated by string matching.
 *
 * Naming: fields that cross this JSON boundary use `snake_case` (`trace_id`,
 * `span_id`, `parent_span_id`, `sampled`) to match the W3C `traceparent` and
 * OTel wire conventions. Everything else in this codebase is camelCase.
 */

export const SPAN_EVENT_TYPE = 'span' as const

/** Tag identifying a record carrying fields to merge onto `invocation_summary`. */
export const SUMMARY_PROPERTIES_TYPE = 'summary_properties' as const

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

export type SpanStatus = 'ok' | 'error'

export type AttributeValue = string | number | boolean

export interface SpanException {
  type?: string
  message: string
  stacktrace?: string
  escaped?: boolean
}

export interface SpanEvent {
  type: typeof SPAN_EVENT_TYPE
  trace_id: string
  span_id: string
  parent_span_id?: string
  name: string
  kind: SpanKind
  /** Unix epoch nanoseconds, encoded as string to avoid JS number precision loss. */
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: SpanStatus
  statusMessage?: string
  service: string
  environment?: string
  attributes?: Record<string, AttributeValue>
  /**
   * Sampling verdict, fixed at trace root and propagated to every child span.
   * The tail worker forwards spans to Axiom's traces store only when true.
   */
  sampled: boolean
  /**
   * Exception info attached when `status === 'error'`. Field names match OTel
   * semantic conventions (`exception.type`, `exception.message`, etc.) so the
   * tail worker maps them directly into the OTLP `exception` span event.
   */
  exception?: SpanException
}

export interface TraceParent {
  trace_id: string
  span_id: string
  sampled: boolean
}

export function isSpanEvent(value: unknown): value is SpanEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.type === SPAN_EVENT_TYPE &&
    typeof v.trace_id === 'string' &&
    typeof v.span_id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.startTimeUnixNano === 'string' &&
    typeof v.endTimeUnixNano === 'string' &&
    typeof v.service === 'string'
  )
}

export function parseTraceparent(header: string | null | undefined): TraceParent | undefined {
  if (!header) return undefined
  const match = TRACEPARENT_RE.exec(header.trim().toLowerCase())
  if (!match) return undefined
  const [, trace_id, span_id, flags] = match
  return { trace_id: trace_id!, span_id: span_id!, sampled: (parseInt(flags!, 16) & 1) === 1 }
}

export function formatTraceparent(trace_id: string, span_id: string, sampled: boolean): string {
  return `00-${trace_id}-${span_id}-${sampled ? '01' : '00'}`
}

export function generateTraceId(): string {
  return randomHex(32)
}

export function generateSpanId(): string {
  return randomHex(16)
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
