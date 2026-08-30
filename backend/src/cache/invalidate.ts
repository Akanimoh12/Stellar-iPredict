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
 */
export async function invalidate(
  redis: Pick<Redis, "del">,
  ...keys: string[]
): Promise<number> {
  if (keys.length === 0) return 0;
  // ioredis accepts (key, ...keys) or (keys[]) — spread works for both.
  return (redis.del as (...args: string[]) => Promise<number>)(...keys);
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
