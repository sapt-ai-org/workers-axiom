# workers-axiom

[![npm version](https://img.shields.io/npm/v/workers-axiom.svg)](https://www.npmjs.com/package/workers-axiom)
[![license](https://img.shields.io/npm/l/workers-axiom.svg)](./LICENSE)

Structured logging, tracing, and metrics for Cloudflare Workers, with an Axiom tail-worker sink.

> **Status:** used internally by Sapt. Open source, MIT-licensed. PRs welcome, support is best-effort.

## What it does

- **Producer** (`workers-axiom/producer`): a `Logger` your worker uses to emit structured logs, metrics, and OpenTelemetry-style spans. Output is plain `console.log` JSON — nothing leaves the worker directly.
- **Tail consumer** (`workers-axiom/tail`): a factory that builds a Cloudflare `tail()` handler. Point your other workers at it via `tail_consumers`. It parses the producer's JSON, batches it, and forwards logs to Axiom's ingest endpoint and sampled spans to Axiom's OTLP traces endpoint.

The two halves communicate through a shared wire format (`workers-axiom/protocol`) and nothing else. You can deploy them independently.

## Install

```bash
pnpm add workers-axiom
```

## Producer usage

```ts
import { withTrace, type Logger } from 'workers-axiom/producer'

interface Env { ENVIRONMENT: string }

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    withTrace(
      {
        name: 'api.fetch',
        kind: 'server',
        service: 'my-api',
        environment: env.ENVIRONMENT,
        headers: request.headers, // continues inbound traceparent if present
      },
      async (logger) => handle(request, env, logger),
      {
        onError: (_err, logger) => {
          logger.error(_err, 'unhandled')
          return new Response('Internal error', { status: 500 })
        },
      }
    ),
}

async function handle(request: Request, env: Env, logger: Logger) {
  logger.info('handling request')
  return logger.span('db.query', { kind: 'client' }, async (logger) => {
    // ... use logger.tracingHeaders() on outbound fetches to propagate the trace
    return new Response('ok')
  })
}
```

## Tail consumer usage

A minimal Worker:

```ts
// src/index.ts
import { createTailHandler } from 'workers-axiom/tail'

interface Env {
  AXIOM_TOKEN: string
  AXIOM_DATASET: string
}

export default {
  tail: (events: TraceItem[], env: Env, ctx: ExecutionContext) =>
    createTailHandler({
      axiomToken: env.AXIOM_TOKEN,
      axiomDataset: env.AXIOM_DATASET,
    })(events, env, ctx),
}
```

```jsonc
// wrangler.jsonc for the tail worker
{
  "name": "my-tail-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "vars": { "AXIOM_DATASET": "my-dataset" }
  // AXIOM_TOKEN set via: wrangler secret put AXIOM_TOKEN
}
```

Then opt each producing worker in:

```jsonc
// wrangler.jsonc for a producer worker
{
  "tail_consumers": [{ "service": "my-tail-worker" }]
}
```

## How it works

Three event types flow through `console.log` from producer to tail:

- **`type: "log"` / `"metric"` / `"error"`** — forwarded to Axiom's ingest endpoint (`https://us-east-1.aws.edge.axiom.co/v1/ingest/{dataset}` by default).
- **`type: "span"`** — wire format defined in `workers-axiom/protocol`. The tail worker filters by `sampled === true`, converts to OTLP, and POSTs to `https://api.axiom.co/v1/traces`.
- **`type: "summary_properties"`** — emitted by `logger.summary({ ... })`. Merged onto a synthesized `invocation_summary` event the tail worker writes for every worker invocation (with CPU/wall time, request metadata from `event.event`, and `trace_id`).

Sampling is decided once at the trace root, propagated via `traceparent`, and stamped on every span. Logs, metrics, and errors are forwarded unconditionally — sampling gates traces only.

## Config reference

### `createTailHandler(config)`

| Field | Required | Default | Notes |
|---|---|---|---|
| `axiomToken` | yes | — | Axiom API token, bearer-auth. |
| `axiomDataset` | yes | — | Dataset name for both ingest and OTLP traces. |
| `ingestBaseUrl` | no | `https://us-east-1.aws.edge.axiom.co/v1/ingest` | Override for EU edge or self-hosted Axiom. Dataset name is appended. |
| `tracesEndpoint` | no | `https://api.axiom.co/v1/traces` | Full URL of the OTLP traces endpoint. |

### `withTrace(options, fn, hooks?)` / `createLogger(options)`

| Field | Required | Default | Notes |
|---|---|---|---|
| `service` | yes | — | OTel `service.name`. |
| `environment` | no | — | OTel `deployment.environment`. `"development"` enables pretty-printed logs and suppresses metrics. |
| `level` | no | `"info"` | Log level. Forced to `"debug"` when `environment === "development"`. |
| `context` | no | `{}` | Correlation fields merged into every emitted record. |
| `isExpectedError` | no | — | Predicate marking expected/business errors so spans aren't flagged as failed. |
| `headers` | no | — | Inbound `Request.headers`. Continues `traceparent` if present. |
| `sampleRate` | no | `1` | Trace-root sampling probability. Inbound traces inherit the upstream verdict. |
| `kv` | no | — | KV namespace for dynamic log-level lookup at key `logLevel` (or `logLevel:{logLevelKey}`). |
| `name` | yes (`withTrace`) | — | Root span name, e.g. `"api.fetch"`, `"scheduled.tick"`. |
| `kind` | no (`withTrace`) | `"server"` | Use `"consumer"` for queue/cron handlers. |

## Outbound trace propagation

The logger doesn't auto-instrument outbound `fetch`. Wrap each outbound call in `logger.span(...)` and copy `logger.tracingHeaders()` onto the request — that's what makes the downstream service join the same trace:

```ts
await logger.span('backend.fetch', { kind: 'client' }, async (logger) => {
  const headers = new Headers(init.headers)
  for (const [k, v] of logger.tracingHeaders()) headers.set(k, v)
  return fetch(url, { ...init, headers })
})
```

`tracingHeaders()` on an unbound root logger returns an empty `Headers` — you must be inside a `.span(...)` for propagation to fire.

## Limitations

- Axiom-specific. There is no sink abstraction; the tail worker speaks Axiom's ingest API and OTLP/HTTP JSON. If you need a different backend, fork the `tail/` directory.
- No browser entry. This package is server-side only, targeted at Cloudflare Workers (and works in any environment with `crypto.getRandomValues` and `console.log`).
- The `tail()` handler runs forwarding synchronously, not via `waitUntil`, so ingest failures surface in tail logs.

## License

MIT
