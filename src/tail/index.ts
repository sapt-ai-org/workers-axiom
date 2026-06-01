import { isSpanEvent, type SpanEvent, SUMMARY_PROPERTIES_TYPE } from '../protocol/index.js'
import { sendSpansToAxiom } from './spans.js'

export interface AxiomConfig {
  /** Axiom API token. */
  axiomToken: string
  /** Axiom dataset receiving both ingest events and OTLP traces. */
  axiomDataset: string
  /**
   * Axiom ingest endpoint. Defaults to the US edge:
   * `https://us-east-1.aws.edge.axiom.co/v1/ingest`.
   * Override with the EU edge or self-hosted Axiom URL as needed.
   * The dataset name is appended automatically.
   */
  ingestBaseUrl?: string
  /**
   * Axiom OTLP traces endpoint. Defaults to `https://api.axiom.co/v1/traces`.
   */
  tracesEndpoint?: string
}

export type TailHandler = (
  events: TraceItem[],
  env: unknown,
  ctx: ExecutionContext
) => Promise<void>

/**
 * Build a Cloudflare Workers `tail()` handler that forwards logs, metrics,
 * errors, and spans from any number of producing workers to Axiom.
 *
 * Configure each producing worker with:
 *   "tail_consumers": [{ "service": "<name-of-this-tail-worker>" }]
 *
 * @example
 * ```ts
 * import { createTailHandler } from 'workers-axiom/tail'
 *
 * interface Env { AXIOM_TOKEN: string; AXIOM_DATASET: string }
 *
 * export default {
 *   tail: (events, env: Env, ctx) =>
 *     createTailHandler({
 *       axiomToken: env.AXIOM_TOKEN,
 *       axiomDataset: env.AXIOM_DATASET,
 *     })(events, env, ctx),
 * }
 * ```
 */
export function createTailHandler(config: AxiomConfig): TailHandler {
  const { axiomToken, axiomDataset } = config
  const ingestBase = config.ingestBaseUrl ?? 'https://us-east-1.aws.edge.axiom.co/v1/ingest'

  return async function tail(events, _env, _ctx) {
    const axiomEvents: AxiomEvent[] = []
    const spans: SpanEvent[] = []

    for (const event of events) {
      const worker = event.scriptName ?? 'unknown'
      const eventTime = new Date(event.eventTimestamp ?? Date.now()).toISOString()

      // Fields the app explicitly opted into surfacing on `invocation_summary`,
      // collected from `summary_properties` records emitted via `logger.summary`.
      // Last-write-wins.
      const summaryProps: Record<string, unknown> = {}
      // Last trace_id observed in this worker invocation. A single invocation
      // can contain multiple traces; we keep the last one because it's the
      // most specific to the invocation's outbound work.
      let traceId: string | undefined

      for (const log of event.logs) {
        const logTime = new Date(log.timestamp).toISOString()

        for (const msg of log.message) {
          if (typeof msg !== 'string') continue

          let parsed: unknown
          try {
            parsed = JSON.parse(msg)
          } catch {
            continue
          }

          if (typeof parsed !== 'object' || parsed === null) continue

          // Span events go to Axiom's /v1/traces endpoint, not the ingest
          // dataset. Don't forward as a regular log row.
          if (isSpanEvent(parsed)) {
            spans.push(parsed)
            traceId = parsed.trace_id
            continue
          }

          const record = parsed as Record<string, unknown>

          if (typeof record.trace_id === 'string') {
            traceId = record.trace_id
          }

          if (record.type === SUMMARY_PROPERTIES_TYPE) {
            for (const [key, value] of Object.entries(record)) {
              if (key === 'type' || key === 'trace_id') continue
              summaryProps[key] = value
            }
            continue
          }

          axiomEvents.push({
            _time: logTime,
            worker,
            ...record,
          })
        }
      }

      const requestInfo = extractRequestInfo(event.event)

      axiomEvents.push({
        _time: eventTime,
        worker,
        type: 'invocation_summary',
        trace_id: traceId,
        ...summaryProps,
        ...requestInfo,
        cpuTime: event.cpuTime,
        wallTime: event.wallTime,
        traceEvent: event.event as unknown,
      })
    }

    // Run synchronously (not via waitUntil) so failures surface in tail logs
    // and OTLP/ingest errors aren't silently swallowed by the runtime.
    await Promise.all([
      sendToAxiom({ events: axiomEvents, axiomToken, axiomDataset, ingestBase }),
      sendSpansToAxiom({
        spans,
        axiomToken,
        axiomDataset,
        ...(config.tracesEndpoint !== undefined && { tracesEndpoint: config.tracesEndpoint }),
      }),
    ])
  }
}


interface AxiomEvent {
  _time: string
  worker: string
  [key: string]: unknown
}

interface TraceItemFetchEvent {
  request?: {
    method?: string
    url?: string
    headers?: Record<string, string>
    cf?: {
      country?: string
      city?: string
      asn?: number
    }
  }
  response?: {
    status?: number
  }
}

interface ExtractedFields {
  reqMethod?: string
  reqUrl?: string
  reqPath?: string
  reqHost?: string
  reqIp?: string
  reqCountry?: string
  reqCity?: string
  reqAsn?: number
  reqUserAgent?: string
  reqCfRay?: string
  resStatus?: number
}

function extractRequestInfo(event: unknown): ExtractedFields {
  const fetchEvent = event as TraceItemFetchEvent | undefined
  if (!fetchEvent?.request) return {}

  const req = fetchEvent.request
  const headers = req.headers ?? {}
  const cf = req.cf ?? {}

  let path: string | undefined
  try {
    if (req.url) path = new URL(req.url).pathname
  } catch {
    // Invalid URL
  }

  return {
    reqMethod: req.method,
    reqUrl: req.url,
    reqPath: path,
    reqHost: headers['host'],
    reqIp: headers['cf-connecting-ip'],
    reqCountry: cf.country,
    reqCity: cf.city,
    reqAsn: cf.asn,
    reqUserAgent: headers['user-agent'],
    reqCfRay: headers['cf-ray'],
    resStatus: fetchEvent.response?.status,
  }
}

async function sendToAxiom(params: {
  events: AxiomEvent[]
  axiomToken: string
  axiomDataset: string
  ingestBase: string
}): Promise<void> {
  const { events, axiomToken, axiomDataset, ingestBase } = params
  if (events.length === 0) return

  const response = await fetch(`${ingestBase}/${axiomDataset}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${axiomToken}`,
    },
    body: JSON.stringify(events),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(
      `Failed to send logs to Axiom: ${response.status} ${response.statusText} — ${text}`
    )
  }
}
