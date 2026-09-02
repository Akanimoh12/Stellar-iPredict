import { type PoolClient } from "pg";
import { getClient } from "./pool.js";

/** Retryable PostgreSQL SQLSTATE error codes: 40001 (serialization_failure), 40P01 (deadlock_detected). */
export const RETRYABLE_SQLSTATE_CODES = new Set(["40001", "40P01"]);

export interface TransactionRetryOptions {
  /** Maximum number of attempts including the initial attempt. Defaults to 5. */
  maxAttempts?: number;
  /** Initial delay before the first retry in milliseconds. Defaults to 50ms. */
  initialDelayMs?: number;
  /** Maximum delay cap between retry attempts in milliseconds. Defaults to 1000ms. */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff. Defaults to 2. */
  backoffMultiplier?: number;
  /** Custom delay function for testing or timer injection. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Checks whether an error from PostgreSQL represents a retryable serialization failure
 * or deadlock error (SQLSTATE 40001 or 40P01).
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    return RETRYABLE_SQLSTATE_CODES.has(code);
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calculates exponential backoff duration with full jitter.
 */
export function calculateRetryDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number
): number {
  const expDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  const boundedDelay = Math.min(expDelay, maxDelayMs);
  return Math.floor(Math.random() * boundedDelay);
}

/**
 * Helper to run a callback inside a PostgreSQL transaction.
 * Begins the transaction, executes the callback, and commits on success.
 * If the callback throws an error, the transaction is rolled back.
 *
 * @param fn The callback function to execute within the transaction
 * @returns The result of the callback
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Helper to execute a callback within a PostgreSQL transaction with automatic retry
 * on transient concurrency errors (serialization failures 40001 and deadlocks 40P01).
 *
 * Each retry attempt executes the entire transaction from the start after the previous
 * transaction has rolled back.
 *
 * IMPORTANT: The callback function must be side-effect free outside the database, as
 * it may be invoked multiple times across retry attempts.
 *
 * @param fn The callback function to execute within the transaction
 * @param options Retry options (max attempts, backoff, jitter, custom sleep)
 * @returns The result of the callback
 */
export async function withTransactionRetry<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 1000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      return await withTransaction(fn);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }

      const delayMs = calculateRetryDelay(
        attempt,
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier
      );
      await sleep(delayMs);
    }
  }
}
