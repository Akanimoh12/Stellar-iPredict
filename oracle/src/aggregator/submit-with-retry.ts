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
 * `isAlreadyFinalized` is re-checked between attempts so a submission that
 * actually succeeded on-chain but timed out on the response is not retried
 * into a duplicate finalization.
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

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      await submit(marketId);
      logger?.info("submit succeeded", { marketId, attempt });
      return true;
    } catch (error) {
      lastError = error;
      logger?.warn("submit failed", { marketId, attempt, error });

      if (await isAlreadyFinalized(marketId)) {
        logger?.info("submit already finalized on-chain despite error", { marketId, attempt });
        return true;
      }

      if (attempt >= options.maxRetries) break;

      const delayMs = computeBackoffDelayMs(attempt, options.baseDelayMs, options.maxDelayMs, random);
      await sleep(delayMs);
    }
  }

  const attempts = options.maxRetries + 1;
  logger?.error("submit failed persistently", { marketId, attempts, error: lastError });

  if (attempts >= options.alertThreshold) {
    await options.onPersistentFailure?.({ marketId, attempts, error: lastError });
  }

  return false;
}
