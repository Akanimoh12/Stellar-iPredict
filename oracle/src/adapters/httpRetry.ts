export interface FetchWithRetryOptions {
  /** Injected for testing; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Base linear backoff between retries, in ms (attempt * this value). */
  retryBackoffMs?: number;
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetches a URL with a request timeout and linear-backoff retries on
 * transient failures (network errors, timeouts, `429` rate limiting, `5xx`).
 * Non-retryable client errors (other `4xx`) throw immediately without
 * consuming the retry budget.
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

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });

      if (response.ok) return response;

      if (!isRetryableStatus(response.status)) {
        throw new AdapterHttpError(`Request failed with status ${response.status}`, response.status);
      }
      lastError = new AdapterHttpError(`Request failed with status ${response.status}`, response.status);
    } catch (error) {
      if (error instanceof AdapterHttpError && error.status !== undefined && !isRetryableStatus(error.status)) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, attempt * retryBackoffMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
