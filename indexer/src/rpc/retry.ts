/**
 * RPC retry — the indexer's configuration of the shared retry utility.
 *
 * Public Soroban RPC nodes rate-limit (~50 req/s per IP) and occasionally fail
 * with transient network errors. This module keeps the indexer making progress
 * instead of crashing on the first hiccup:
 *
 *   - retries transient failures (network errors, timeouts, 5xx, 429)
 *   - backs off exponentially with jitter, honouring a 429 `Retry-After` header
 *   - caps the delay and the number of attempts, then surfaces the last error
 *
 * Permanent failures (e.g. a 4xx other than 429, or a `LedgerGapError` raised by
 * `getEvents`) are not retried — retrying them would only waste time and hammer
 * the node, so they propagate immediately.
 *
 * The retry *mechanism* lives in `@ipredict/shared` (issue #641): one backoff
 * curve, one jitter policy and one type-based retryability rule for every
 * service. What this module owns is the indexer's budget — five retries, a
 * quarter-second base and a 30 s ceiling — expressed as the
 * {@link RPC_RETRY_CONFIG} profile.
 */

import {
  CircuitBreakerOpenError,
  RPC_RETRY_CONFIG,
  classifyFailure,
  createCircuitBreaker,
  createRetryRunner,
  withRetry as runWithRetry,
  type CircuitBreaker,
  type RetryAttempt,
  type RetryOptions,
} from "@ipredict/shared";
import { recordCircuitBreakerState } from "../metrics.js";

export type { RetryAttempt, RetryOptions };
export {
  CircuitBreakerOpenError,
  RetryExhaustedError,
  getRetryAfterMs,
  getStatusCode,
  jitteredDelayMs,
} from "@ipredict/shared";

const runRpcRetry = createRetryRunner(RPC_RETRY_CONFIG);

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * One breaker for every indexer RPC call (issue #637).
 *
 * It records one outcome per retry *sequence*: a whole budget spent against a
 * down node is one transient failure. Three consecutive exhausted budgets open
 * the breaker, so a later outage fails immediately instead of multiplying a
 * 30-second retry budget across every poll. A single successful probe after
 * the reset window closes it again.
 */
export const indexerRpcCircuitBreaker: CircuitBreaker = createCircuitBreaker({
  name: "indexer-soroban-rpc",
  failureThreshold: positiveEnv("RPC_CIRCUIT_FAILURE_THRESHOLD", 3),
  resetTimeoutMs: positiveEnv("RPC_CIRCUIT_RESET_TIMEOUT_MS", 30_000),
  halfOpenSuccesses: positiveEnv("RPC_CIRCUIT_HALF_OPEN_SUCCESSES", 1),
  permanentErrorNames: RPC_RETRY_CONFIG.permanentErrorNames,
  onOpen: (snapshot) => {
    recordCircuitBreakerState("open", "open");
    console.warn("[ipredict-indexer] Soroban RPC circuit breaker opened", {
      breaker: snapshot.name,
      failures: snapshot.failures,
      retryAfterMs: positiveEnv("RPC_CIRCUIT_RESET_TIMEOUT_MS", 30_000),
    });
  },
  onHalfOpen: () => {
    recordCircuitBreakerState("half-open");
    console.info("[ipredict-indexer] Soroban RPC circuit breaker probing recovery");
  },
  onClose: () => {
    recordCircuitBreakerState("closed");
    console.info("[ipredict-indexer] Soroban RPC circuit breaker closed");
  },
});

/**
 * True when the error represents an HTTP 429 (rate limited).
 *
 * The verdict comes from the error's *type* — its status code — not from the
 * text of its message, so a node that rewords its error cannot change how the
 * indexer reacts to it.
 */
export function isRateLimitError(error: unknown): boolean {
  return classifyFailure(error).kind === "rate-limit";
}

/**
 * True when the failure is worth another attempt: rate limits, server errors
 * and transport failures are transient, other 4xx responses are not, and a
 * ledger gap is never retryable.
 */
export function isTransientError(error: unknown): boolean {
  return classifyFailure(error, {
    permanentErrorNames: RPC_RETRY_CONFIG.permanentErrorNames,
  }).retryable;
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
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions<T> = {}): Promise<T> {
  try {
    return await indexerRpcCircuitBreaker.run(() => runRpcRetry(fn, options));
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      recordCircuitBreakerState("open", "reject");
    }
    throw error;
  }
}
