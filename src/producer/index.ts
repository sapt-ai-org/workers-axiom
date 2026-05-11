export {
  LogLevel,
  createLogger,
  noopLogger,
  withTrace,
  type KVLike,
  type LogContext,
  type Logger,
  type LoggerOptions,
  type WithTraceOptions,
} from './logger'

export type { SpanOptions, TraceContext } from './tracing'

// Re-export wire-format types that consumers commonly need when extending
// the producer (custom attributes, propagation helpers in middleware, etc.).
export {
  SPAN_EVENT_TYPE,
  SUMMARY_PROPERTIES_TYPE,
  isSpanEvent,
  parseTraceparent,
  formatTraceparent,
  type AttributeValue,
  type SpanEvent,
  type SpanKind,
  type SpanStatus,
  type TraceParent,
} from '../protocol'
