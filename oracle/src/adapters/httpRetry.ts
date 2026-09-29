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
  maxRetries?: number;
  /** Base linear backoff between retries, in ms (attempt * this value). */
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
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;

export class AdapterHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AdapterHttpError";
  }
}

/** A single attempt, or the whole retry budget, ran out of time. */
export class AdapterTimeoutError extends Error {
  constructor(
    message: string,
    public readonly scope: "attempt" | "total",
  ) {
    super(message);
    this.name = "AdapterTimeoutError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Default total budget: every attempt at full timeout plus all backoff sleeps. */
export function defaultTotalTimeoutMs(timeoutMs: number, maxRetries: number, retryBackoffMs: number): number {
  let backoff = 0;
  for (let attempt = 1; attempt < maxRetries; attempt++) backoff += attempt * retryBackoffMs;
  return maxRetries * timeoutMs + backoff;
}

/**
 * Rejects when `ms` elapses. Racing against this guarantees the attempt ends
 * even if the injected/underlying fetch ignores its abort signal.
 */
function timeoutRace(ms: number, make: () => Error): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(make()), Math.max(0, ms));
  });
  // Avoid unhandled rejection noise when the race is won by the real request.
  promise.catch(() => undefined);
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Fetches a URL with a hard per-attempt timeout and linear-backoff retries on
 * transient failures (network errors, timeouts, `429` rate limiting, `5xx`).
 * A timed-out attempt is treated as transient and consumes one retry.
 * Non-retryable client errors (other `4xx`) throw immediately.
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
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const totalTimeoutMs =
    options.totalTimeoutMs ?? defaultTotalTimeoutMs(timeoutMs, maxRetries, retryBackoffMs);

  const deadline = Date.now() + totalTimeoutMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AdapterTimeoutError(`Total retry budget of ${totalTimeoutMs}ms exhausted for ${url}`, "total");
    }

    // The attempt may not outlive the overall budget.
    const attemptMs = Math.min(timeoutMs, remaining);
    const cappedByTotal = attemptMs < timeoutMs;
    const controller = new AbortController();
    const race = timeoutRace(attemptMs, () => {
      controller.abort();
      return cappedByTotal
        ? new AdapterTimeoutError(`Total retry budget of ${totalTimeoutMs}ms exhausted for ${url}`, "total")
        : new AdapterTimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`, "attempt");
    });

    try {
      const attemptWork = (async () => {
        const response = await fetchFn(url, { ...init, signal: controller.signal });
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
        throw new AdapterHttpError(`Request failed with status ${response.status}`, response.status);
      })();
      // If the race wins, the losing work must not surface as unhandled.
      attemptWork.catch(() => undefined);

      return await Promise.race([attemptWork, race.promise]);
    } catch (error) {
      if (error instanceof AdapterHttpError && error.status !== undefined && !isRetryableStatus(error.status)) {
        throw error;
      }
      if (error instanceof AdapterTimeoutError && error.scope === "total") {
        throw error;
      }
      lastError = error;
    } finally {
      race.cancel();
    }

    if (attempt < maxRetries) {
      const sleepMs = attempt * retryBackoffMs;
      if (Date.now() + sleepMs >= deadline) {
        throw new AdapterTimeoutError(`Total retry budget of ${totalTimeoutMs}ms exhausted for ${url}`, "total");
      }
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
