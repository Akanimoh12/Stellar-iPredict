import { HTTP_RETRY_CONFIG, RetryTimeoutError, createRetryRunner, type RetryOptions } from "@ipredict/shared";
import { retryAfterFromHeaders } from "./http.js";

export interface FetchWithRetryOptions {
  /** Injected for testing; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Per-attempt timeout in ms, covering connection, headers and the response
   * body. Node's fetch has no default timeout, so without this a provider that
   * accepts the connection and never answers holds the request until TCP drops.
   * Configure per adapter, since providers differ in latency.
   */
  timeoutMs?: number;
  /**
   * Total number of attempts, the first try included.
   *
   * The name is historical: the shared retry engine counts *retries* after the
   * first attempt, so the value is translated here (`attempts - 1`). Keeping the
   * original meaning means `maxRetries: 1` still asks a provider exactly once
   * — which is what the health probe relies on.
   */
  maxRetries?: number;
  /**
   * Base delay of the backoff between retries, in ms. The delay grows
   * exponentially from it (`base * 2^attempt`), capped at 30 s, and is drawn
   * with full jitter. A provider `Retry-After` on a retryable response
   * replaces this delay.
   */
  retryBackoffMs?: number;
  /**
   * Upper bound on wall-clock time across every attempt and backoff sleep.
   * Defaults to `maxRetries * timeoutMs` plus the backoff schedule, so worst
   * case latency is explicit rather than an emergent product of the knobs.
   */
  totalTimeoutMs?: number;
  /** Successful adapter responses are cached for this many milliseconds. Defaults to 5 seconds. */
  cacheTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;

/** The retry engine, configured with the HTTP budget (issue #641). */
const runHttpRetry = createRetryRunner(HTTP_RETRY_CONFIG);

export class AdapterHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** Delay the provider asked for via `Retry-After`, in ms. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AdapterHttpError";
  }
}

/**
 * A single attempt, or the whole retry budget, ran out of time.
 *
 * Extends the shared {@link RetryTimeoutError} so the shared classifier knows
 * an attempt timeout is transient (worth another try) while a total-budget
 * timeout is not.
 */
export class AdapterTimeoutError extends RetryTimeoutError {
  constructor(message: string, scope: "attempt" | "total") {
    super(message, scope);
    this.name = "AdapterTimeoutError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Default total budget: every attempt at full timeout plus all backoff sleeps.
 *
 * The backoff is exponential, so the sleeps are `base * 2^0`, `base * 2^1`, …
 * The jitter is full, which means the real delay is at most the ceiling, so
 * the ceiling sum is the worst case the budget has to cover.
 */
export function defaultTotalTimeoutMs(timeoutMs: number, maxRetries: number, retryBackoffMs: number): number {
  let backoff = 0;
  for (let attempt = 0; attempt < maxRetries - 1; attempt++) backoff += retryBackoffMs * 2 ** attempt;
  return maxRetries * timeoutMs + backoff;
}

/**
 * Fetches a URL with a hard per-attempt timeout and exponential-backoff
 * retries on transient failures (network errors, timeouts, `429` rate
 * limiting, `5xx`). A timed-out attempt is treated as transient and consumes
 * one retry. Non-retryable client errors (other `4xx`) throw immediately.
 *
 * The retry mechanism — the backoff curve, the jitter, the retryability rule
 * — is the shared utility (issue #641); this module owns the HTTP budget and
 * the shape of an adapter failure. Retryability is decided by the *type* of
 * the failure (its status code), never by the text of its message.
 *
 * When a retryable response carries `Retry-After`, the next attempt waits that
 * long instead of following the backoff schedule. If the requested wait does
 * not fit in the remaining budget the rate-limit error is thrown at once
 * (with its `retryAfterMs`), rather than retrying before the provider allows.
 *
 * Total time is bounded by `totalTimeoutMs`; when the budget is spent the call
 * fails with an {@link AdapterTimeoutError} instead of starting another attempt.
 * The response body is buffered inside the attempt's timeout, so a provider that
 * sends headers and then stalls cannot hang the caller's `.json()` afterwards.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxRetries ?? DEFAULT_MAX_ATTEMPTS);
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const totalTimeoutMs =
    options.totalTimeoutMs ?? defaultTotalTimeoutMs(timeoutMs, maxAttempts, retryBackoffMs);

  const retryOptions: RetryOptions<Response> = {
    // The engine counts retries after the first attempt; the option above
    // counts attempts in total.
    maxRetries: maxAttempts - 1,
    attemptTimeoutMs: timeoutMs,
    totalTimeoutMs,
    baseDelayMs: retryBackoffMs,
    label: url,
    timeoutError: (message, scope) => new AdapterTimeoutError(message, scope),
    // The last failure is surfaced as-is, so callers keep seeing the adapter's
    // own error type instead of a retry wrapper.
    finalError: (error) => (error instanceof Error ? error : new Error(String(error))),
  };

  return runHttpRetry<Response>(async (_attempt, signal) => {
    const response = await fetchFn(url, { ...init, signal });
    if (response.ok) {
      // Buffer real responses inside the attempt timeout so a stalled body
      // cannot hang the caller's later `.json()`.
      if (typeof Response !== "undefined" && response instanceof Response) {
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return response;
    }
    const retryAfterMs = isRetryableStatus(response.status)
      ? retryAfterFromHeaders(response.headers)
      : undefined;
    throw new AdapterHttpError(`Request failed with status ${response.status}`, response.status, retryAfterMs);
  }, retryOptions);
}
