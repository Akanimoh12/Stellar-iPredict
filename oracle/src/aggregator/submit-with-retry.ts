import type { Logger } from "../log.js";

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full-jitter exponential backoff (AWS-style): delay is a random value in
 * [0, min(maxDelayMs, baseDelayMs * 2^attempt)) rather than the full
 * exponential value, so retries from concurrent failures don't line up and
 * hammer the RPC endpoint at the same instant.
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const cappedExponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * cappedExponential);
}

/**
 * Retries a single market's on-chain submission with exponential backoff.
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
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const logger = options.logger;
  let lastError: unknown;

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

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delayMs = computeBackoffDelayMs(attempt - 1, options.baseDelayMs, options.maxDelayMs, random);
      await sleep(delayMs);

      const finalized = await checkFinalized(attempt);
      if (finalized) {
        logger?.info("submit already finalized on-chain before retry", { marketId, attempt });
        return true;
      }
      if (finalized === undefined) {
        logger?.warn("skipping retry: on-chain state unknown", { marketId, attempt });
        continue;
      }
    }

    try {
      await submit(marketId);
      logger?.info("submit succeeded", { marketId, attempt });
      return true;
    } catch (error) {
      lastError = error;
      logger?.warn("submit failed", { marketId, attempt, error });

      if (await checkFinalized(attempt)) {
        logger?.info("submit already finalized on-chain despite error", { marketId, attempt });
        return true;
      }
    }
  }

  const attempts = options.maxRetries + 1;
  logger?.error("submit failed persistently", { marketId, attempts, error: lastError });

  if (attempts >= options.alertThreshold) {
    await options.onPersistentFailure?.({ marketId, attempts, error: lastError });
  }

  return false;
}
