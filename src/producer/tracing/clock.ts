/**
 * Monotonic-anchored wall clock for span timing.
 *
 * Span timestamps come from a single anchor captured at root-logger creation:
 *   - `unixMsAtAnchor` — Date.now() at anchor time (wall clock)
 *   - `perfAtAnchor`   — performance.now() at anchor time (monotonic, sub-ms)
 *
 * Subsequent reads compute `unixMsAtAnchor + (performance.now() - perfAtAnchor)`.
 * This preserves sub-ms ordering within a request and avoids drift if Date.now()
 * jumps mid-request (rare on Workers, but free to guard against).
 *
 * Cross-service clock skew is not addressed here — Workers in different colos may
 * have small wall-clock differences. Tracing UIs tolerate this; it's not fixable
 * from inside the worker.
 */
export interface Clock {
  /** Returns the current time as Unix epoch nanoseconds (string, no precision loss). */
  nowUnixNano(): string
}

export function createClock(): Clock {
  const unixMsAtAnchor = Date.now()
  const perfAtAnchor = performanceNowOrFallback()

  return {
    nowUnixNano(): string {
      const elapsedMs = performanceNowOrFallback() - perfAtAnchor
      const unixMs = unixMsAtAnchor + elapsedMs
      return BigInt(Math.trunc(unixMs * 1_000_000)).toString()
    },
  }
}

function performanceNowOrFallback(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}
