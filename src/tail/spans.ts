/**
 * Span forwarding to Axiom's OTLP `/v1/traces` endpoint.
 *
 * Spans arrive as `console.log` JSON events with the {@link SpanEvent} wire
 * format. The sampling verdict is decided once at the trace root by the
 * producing logger and stamped on every span via `SpanEvent.sampled`; the tail
 * worker is a pure router that forwards only `sampled === true` spans.
 * Logs/metrics/errors are forwarded unconditionally by the caller — sampling
 * gates traces, not log visibility.
 */
import type { SpanEvent } from '../protocol/index.js'

export interface SendSpansInput {
  spans: SpanEvent[]
  axiomToken: string
  axiomDataset: string
  /** Full URL of Axiom's OTLP traces endpoint. Defaults to `https://api.axiom.co/v1/traces`. */
  tracesEndpoint?: string
}

export async function sendSpansToAxiom(input: SendSpansInput): Promise<void> {
  const { spans, axiomToken, axiomDataset } = input
  const endpoint = input.tracesEndpoint ?? 'https://api.axiom.co/v1/traces'
  const kept = spans.filter((s) => s.sampled)
  if (kept.length === 0) return

  const body = toOtlpPayload(kept)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${axiomToken}`,
      'X-Axiom-Dataset': axiomDataset,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(
      `Failed to send spans to Axiom: ${response.status} ${response.statusText} — ${text}`
    )
  }
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] }
  scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[]
}

interface OtlpAttribute {
  key: string
  value: { stringValue: string } | { intValue: number } | { boolValue: boolean }
}

interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: number; message?: string }
  attributes: OtlpAttribute[]
  events?: { timeUnixNano: string; name: string; attributes: OtlpAttribute[] }[]
}

const SPAN_KIND_TO_OTLP: Record<SpanEvent['kind'], number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
}

/**
 * Group spans by `(service, environment)` so each unique pair becomes its own
 * OTLP `ResourceSpans` entry. Axiom's Traces dashboard groups by `service.name`
 * from the resource block, so this grouping is what makes per-service filtering
 * work.
 */
function toOtlpPayload(spans: SpanEvent[]): { resourceSpans: OtlpResourceSpans[] } {
  const byResource = new Map<string, SpanEvent[]>()
  for (const span of spans) {
    const key = `${span.service} ${span.environment ?? ''}`
    const list = byResource.get(key)
    if (list) list.push(span)
    else byResource.set(key, [span])
  }

  const resourceSpans: OtlpResourceSpans[] = []
  for (const group of byResource.values()) {
    const first = group[0]!
    const resource = {
      attributes: [
        attr('service.name', first.service),
        ...(first.environment ? [attr('deployment.environment', first.environment)] : []),
      ],
    }
    resourceSpans.push({
      resource,
      scopeSpans: [{ scope: { name: first.service }, spans: group.map(toOtlpSpan) }],
    })
  }
  return { resourceSpans }
}

function toOtlpSpan(span: SpanEvent): OtlpSpan {
  const attributes = Object.entries(span.attributes ?? {}).map(([key, value]) => attr(key, value))
  const result: OtlpSpan = {
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    name: span.name,
    kind: SPAN_KIND_TO_OTLP[span.kind],
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    status: { code: span.status === 'error' ? 2 : 1, message: span.statusMessage },
    attributes,
  }
  if (span.exception) {
    const eventAttrs: OtlpAttribute[] = []
    for (const [key, value] of Object.entries(span.exception)) {
      if (value === undefined) continue
      eventAttrs.push(attr(`exception.${key}`, value as string | number | boolean))
    }
    result.events = [
      { timeUnixNano: span.endTimeUnixNano, name: 'exception', attributes: eventAttrs },
    ]
  }
  return result
}

function attr(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  return { key, value: { intValue: value } }
}
