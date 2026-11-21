import {
  CircuitBreakerOpenError,
  SUBMIT_RETRY_CONFIG,
  classifyFailure,
  createRetryRunner,
  type RetryOptions as SharedRetryOptions,
} from "@ipredict/shared";
import type { Logger } from "../log.js";
import {
  reportSorobanRpcCircuitRejection,
  sorobanRpcCircuitBreaker,
} from "./rpc-circuit-breaker.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  alertThreshold: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onPersistentFailure?: (info: { marketId: string; attempts: number; error: unknown }) => Promise<void> | void;
  logger?: Logger;
}

/**
 * Full-jitter exponential backoff (AWS-style).
 *
 * Re-exported from the shared retry utility (issue #641) so the delay curve
 * that every service uses can be asserted from here too.
 */
export { computeBackoffDelayMs } from "@ipredict/shared";

/** The retry engine, configured with the on-chain submission budget. */
const runSubmitRetry = createRetryRunner(SUBMIT_RETRY_CONFIG);

/**
 * Retries a single market's on-chain submission with exponential backoff.
 *
 * The retry *mechanism* — the backoff curve, the jitter, the retryability
 * rule — is the shared utility (issue #641); this function owns what makes a
 * submission different from a plain request: the on-chain state check.
 *
 * On-chain state is checked after every failure and again immediately before
 * every retry, so a submission that actually landed (e.g. it timed out on the
 * response, or was still in flight during the backoff sleep) is never resent
 * as a duplicate bond. If that check itself fails the state is unknown, so the
 * retry is skipped rather than risking a second submission; the next attempt
 * checks again before sending anything.
 */
export async function submitWithRetry(
  marketId: string,
  submit: (marketId: string) => Promise<void>,
  isAlreadyFinalized: (marketId: string) => Promise<boolean>,
  options: RetryOptions,
): Promise<boolean> {
  const logger = options.logger;

  // Issue #637: fail fast when the shared RPC breaker is open. The breaker's
  // own onOpen hook has already alerted, so this is not a persistent-submit
  // failure and must not fire a second, misleading alert.
  try {
    sorobanRpcCircuitBreaker.assertAllowed();
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      reportSorobanRpcCircuitRejection();
      logger?.warn("submit skipped: Soroban RPC circuit breaker is open", {
        marketId,
        retryAfterMs: Math.round(error.retryAfterMs),
      });
      return false;
    }
    throw error;
  }

  let lastError: unknown;
  let attempts = 0;

  /** `undefined` means the on-chain state could not be determined. */
  const checkFinalized = async (attempt: number): Promise<boolean | undefined> => {
    try {
      return await isAlreadyFinalized(marketId);
    } catch (error) {
      lastError = error;
      logger?.warn("on-chain state check failed", { marketId, attempt, error });
      return undefined;
    }
  };

  const retryOptions: SharedRetryOptions<boolean> = {
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
    sleep: options.sleep,
    random: options.random,
    /**
     * Consulted after the backoff sleep, before the next submission.
     *
     * This is where the on-chain state decides whether another submission may
     * be sent: `stop` when the market is already finalized, `skip` while the
     * state is unknown.
     */
    beforeRetry: async ({ attempt }) => {
      const finalized = await checkFinalized(attempt);
      if (finalized) {
        logger?.info("submit already finalized on-chain before retry", { marketId, attempt });
        return { action: "stop", value: true };
      }
      if (finalized === undefined) {
        logger?.warn("skipping retry: on-chain state unknown", { marketId, attempt });
        return { action: "skip" };
      }
      return { action: "retry" };
    },
    /**
     * The last failure is surfaced as-is, so the alert reports the underlying
     * error rather than a retry wrapper.
     */
    finalError: (error, count) => {
      attempts = count;
      return error instanceof Error ? error : new Error(String(error));
    },
  };

  try {
    const result = await runSubmitRetry<boolean>(async (attempt) => {
      try {
        await submit(marketId);
        logger?.info("submit succeeded", { marketId, attempt: attempt + 1 });
        return true;
      } catch (error) {
        lastError = error;
        logger?.warn("submit failed", { marketId, attempt: attempt + 1, error });

        if (await checkFinalized(attempt + 1)) {
          logger?.info("submit already finalized on-chain despite error", { marketId, attempt: attempt + 1 });
          return true;
        }
        throw error;
      }
    }, retryOptions);

    // A successful retry sequence proves the RPC endpoint is reachable again.
    sorobanRpcCircuitBreaker.recordSuccess();
    return result;
  } catch (error) {
    // The retry budget is spent.
    lastError = lastError ?? error;

    // Only transient failures say anything about RPC availability. A domain
    // error (already finalized, bad request) is a healthy response, so it
    // clears the failure streak instead of opening the breaker.
    const classification = classifyFailure(lastError, {
      permanentErrorNames: SUBMIT_RETRY_CONFIG.permanentErrorNames,
    });
    if (classification.retryable) sorobanRpcCircuitBreaker.recordFailure(lastError);
    else sorobanRpcCircuitBreaker.recordSuccess();

    logger?.error("submit failed persistently", { marketId, attempts, error: lastError });

    if (attempts >= options.alertThreshold) {
      await options.onPersistentFailure?.({ marketId, attempts, error: lastError });
    }

    return false;
  }
}
