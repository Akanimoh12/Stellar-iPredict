/**
 * RPC retry with exponential backoff + jitter.
 *
 * Public Soroban RPC nodes rate-limit (~50 req/s per IP) and occasionally fail
 * with transient network errors. This module wraps an arbitrary async RPC call
 * so the indexer keeps making progress instead of crashing on the first hiccup:
 *
 *   - retries transient failures (network errors, timeouts, 5xx, 429)
 *   - backs off exponentially with jitter, honouring a 429 `Retry-After` header
 *   - caps the delay and the number of attempts, then surfaces the last error
 *
 * Permanent failures (e.g. a 4xx other than 429, or a `LedgerGapError` raised by
 * `getEvents`) are not retried — retrying them would only waste time and hammer
 * the node, so they propagate immediately.
 */

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default: 5. */
  maxRetries?: number;
  /** Base delay used for the exponential backoff, in ms. Default: 250. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay, in ms. Default: 30_000. */
  maxDelayMs?: number;
  /**
   * Decides whether a thrown error is worth retrying. Defaults to
   * {@link isTransientError}. Return `false` to surface the error immediately.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Invoked before each backoff sleep — useful for logging/metrics. */
  onRetry?: (info: RetryAttempt) => void;
  /** Injected sleep, for tests. Defaults to a `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected RNG in [0, 1), for deterministic jitter in tests. */
  random?: () => number;
}

export interface RetryAttempt {
  /** 1-based attempt number that just failed. */
  attempt: number;
  /** The error thrown by the failed attempt. */
  error: unknown;
  /** Delay, in ms, before the next attempt. */
  delayMs: number;
}

/**
 * Thrown when every attempt has been exhausted. Wraps the last underlying
 * error so callers can inspect it via {@link RetryExhaustedError.cause}.
 */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`RPC call failed after ${attempts} attempt(s): ${causeMessage}`);
    this.name = "RetryExhaustedError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort extraction of an HTTP status code from heterogeneous error shapes. */
export function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, any>;
  const candidates = [e.status, e.statusCode, e.code, e.response?.status];
  for (const candidate of candidates) {
    const num = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof num === "number" && Number.isFinite(num) && num >= 100 && num < 600) {
      return num;
    }
  }
  return undefined;
}

/** True when the error represents an HTTP 429 (rate limited). */
export function isRateLimitError(error: unknown): boolean {
  if (getStatusCode(error) === 429) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b429\b/.test(message) || /too many requests|rate.?limit/i.test(message);
}

/**
 * Reads a `Retry-After` header (seconds, or an HTTP date) off an error and
 * returns the suggested delay in ms, or `undefined` when absent/unparseable.
 */
export function getRetryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, any>;
  const headers = e.response?.headers ?? e.headers;
  const raw =
    (typeof headers?.get === "function" ? headers.get("retry-after") : undefined) ??
    headers?.["retry-after"] ??
    headers?.["Retry-After"] ??
    e.retryAfter;
  if (raw == null) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);

  return undefined;
}

/**
 * Default retry predicate: retry on rate limits, server errors, and errors with
 * no recognisable HTTP status (network/timeout failures). Do not retry other
 * 4xx client errors — they are deterministic and won't fix themselves.
 */
export function isTransientError(error: unknown): boolean {
  // A LedgerGapError (or anything explicitly marked non-retryable) is permanent.
  if (error && typeof error === "object" && (error as any).name === "LedgerGapError") {
    return false;
  }
  if (isRateLimitError(error)) return true;

  const status = getStatusCode(error);
  if (status === undefined) return true; // network/timeout — worth retrying
  return status >= 500 && status < 600;
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff + full jitter.
 *
 * The backoff for attempt `n` (0-based) is `min(maxDelayMs, baseDelayMs * 2^n)`,
 * randomised with full jitter to avoid thundering-herd retries. A 429 with a
 * `Retry-After` header overrides the computed delay (still capped by maxDelayMs).
 *
 * @throws {RetryExhaustedError} once attempts are exhausted, wrapping the last error.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = options.isRetryable ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const hasAttemptsLeft = attempt < maxRetries;
      if (!hasAttemptsLeft || !isRetryable(error)) {
        break;
      }

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      // Full jitter: pick uniformly in [0, exponential] to spread out retries.
      let delayMs = Math.floor(random() * exponential);

      // Honour a server-provided Retry-After on 429s, capped by maxDelayMs.
      const retryAfterMs = getRetryAfterMs(error);
      if (retryAfterMs !== undefined) {
        delayMs = Math.min(maxDelayMs, retryAfterMs);
      }

      options.onRetry?.({ attempt: attempt + 1, error, delayMs });
      await sleep(delayMs);
    }
  }

  throw new RetryExhaustedError(maxRetries + 1, lastError);
}
