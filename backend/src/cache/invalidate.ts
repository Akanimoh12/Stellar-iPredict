/**
 * Cache invalidation helpers.
 *
 * Provides a low-level `invalidate(keys)` primitive and higher-level helpers
 * that map domain events to the correct set of cache keys, mirroring the
 * strategy documented in docs/ORACLE_AND_BACKEND.md §Caching Strategy.
 *
 * ## Key invariant
 *
 * All keys are built via the versioned builders in `cacheKeys.ts` so they
 * always include the current namespace and version prefix.  This ensures that
 * a version bump logically invalidates every key in one step, and that the
 * same set of keys is produced whether the delete happens here or in
 * `getOrSet`.
 *
 * ## Compatibility with the indexer
 *
 * `indexer/src/cache.ts` exposes matching `invalidateMarketCache` and
 * `invalidateLeaderboardCache` helpers that call through to this module's
 * versioned keys.  Keep the two files in sync whenever you change which keys
 * map to which event type.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Caching Strategy
 */

import type { Redis } from "ioredis";
import { getCircuitBreaker } from "./circuitBreaker.js";
import {
  marketKey,
  marketsAllKey,
  marketsActiveKey,
  leaderboardKey,
  betsKey,
  oddsKey,
} from "./cacheKeys.js";

// ---------------------------------------------------------------------------
// Core primitive
// ---------------------------------------------------------------------------

/**
 * Delete one or more cache keys from Redis in a single call.
 *
 * Accepts the ioredis `Redis` type but the spread-DEL signature is also
 * satisfied by the lightweight `{ del(...keys: string[]): Promise<unknown> }`
 * interface used in tests and the indexer, so the function is effectively
 * duck-typed at the call site.
 *
 * ```ts
 * import { invalidate } from "./invalidate.js";
 *
 * await invalidate(redis, marketsAllKey(), marketsActiveKey());
 * ```
 *
  * @param redis  An ioredis client (or any object with a `del` method).
 * @param keys   One or more cache keys to delete.
 * @returns      The number of keys actually deleted (forwarded from Redis).
 *
 * ## Failure handling
 *
 * When Redis is unavailable the circuit breaker is open and the call
 * returns `0` without touching the network.  When Redis is reachable but
 * the DEL command itself rejects, the error is logged (rate-limited to
 * avoid log spam during outages) and `0` is returned — a failed
 * invalidation means the next reader gets a stale entry for at most one
 * TTL, which is acceptable degradation under outage conditions (issue #481).
 */
// Rate-limited logger — prevents log spam during sustained Redis outages.
// Logs at most once per CACHE_FAILURE_LOG_INTERVAL_MS, but counts total failures.
export let cacheFailureLogCount = 0;
const CACHE_FAILURE_LOG_INTERVAL_MS = 30_000;
let lastCacheFailureLog = 0;

/**
 * Log a cache failure, rate-limited to avoid log spam during outages.
 * Exported so tests can reset the counter and verify behaviour (#481).
 */
export function logCacheFailure(error: unknown): void {
  cacheFailureLogCount++;
  const now = Date.now();
  if (now - lastCacheFailureLog >= CACHE_FAILURE_LOG_INTERVAL_MS) {
    lastCacheFailureLog = now;
    console.warn(
      `[cache] failure #${cacheFailureLogCount} ` +
        `(error: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Reset the rate-limited failure logger — for tests only. */
export function resetFailureLogger(): void {
  cacheFailureLogCount = 0;
  lastCacheFailureLog = 0;
}

export async function invalidate(
  redis: Pick<Redis, "del">,
  ...keys: string[]
): Promise<number> {
  if (keys.length === 0) return 0;

  const circuit = getCircuitBreaker();
  if (!circuit.canAttempt()) {
    return 0;
  }

  try {
    // Await the DEL call so that rejections are caught and the circuit
    // breaker is updated only after Redis has actually responded (#481).
    const count = await (redis.del as (...args: string[]) => Promise<number>)(
      ...keys,
    );
    circuit.recordSuccess();
    return count;
  } catch (error) {
    circuit.recordFailure();
    logCacheFailure(error);
    // Swallowed — next read will refresh from the DB within one TTL.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Domain-level helpers
// ---------------------------------------------------------------------------

/**
 * Invalidate caches that become stale when a market is **created**.
 *
 * Clears the full market list and the active-markets list so the next reader
 * fetches a fresh copy that includes the new market.
 *
 * Event mapping: `mkt:created` → `markets:all`, `markets:active`
 */
export async function invalidateOnMarketCreated(
  redis: Pick<Redis, "del">,
): Promise<number> {
  return invalidate(redis, marketsAllKey(), marketsActiveKey());
}

/**
 * Invalidate caches that become stale when a **bet is placed** on a market.
 *
 * Clears the individual market entry (odds/totals changed) and the
 * active-markets list (volume/order may change).
 *
 * Event mapping: `bet:placed` → `market:{id}`, `odds:{id}`, `markets:active`
 */
export async function invalidateOnBetPlaced(
  redis: Pick<Redis, "del">,
  marketId: number | string,
): Promise<number> {
  return invalidate(redis, marketKey(marketId), oddsKey(marketId), marketsActiveKey());
}

/**
 * Invalidate caches that become stale when a market is **resolved**.
 *
 * Clears the individual market, both market-list caches, the bet list for
 * that market, and the leaderboard (resolved bets may change rankings).
 *
 * Event mapping: `mkt:resolved` → `market:{id}`, `odds:{id}`, `markets:all`,
 *                                  `markets:active`, `bets:{id}`,
 *                                  `leaderboard:top20`
 */
export async function invalidateOnMarketResolved(
  redis: Pick<Redis, "del">,
  marketId: number | string,
): Promise<number> {
  return invalidate(
    redis,
    marketKey(marketId),
    oddsKey(marketId),
    marketsAllKey(),
    marketsActiveKey(),
    betsKey(marketId),
    leaderboardKey(),
  );
}

/**
 * Invalidate caches that become stale when a market is **cancelled**.
 *
 * Same scope as resolution — the market status changed and any cached lists
 * are now stale.
 *
 * Event mapping: `mkt:cancelled` → `market:{id}`, `odds:{id}`, `markets:all`,
 *                                   `markets:active`
 */
export async function invalidateOnMarketCancelled(
  redis: Pick<Redis, "del">,
  marketId: number | string,
): Promise<number> {
  return invalidate(
    redis,
    marketKey(marketId),
    oddsKey(marketId),
    marketsAllKey(),
    marketsActiveKey(),
  );
}
