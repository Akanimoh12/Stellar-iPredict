/**
 * Cache invalidation helpers for the indexer.
 *
 * These helpers mirror `backend/src/cache/invalidate.ts` but operate on the
 * indexer's lightweight `RedisClient` interface (which only requires `del`)
 * rather than the full ioredis `Redis` type, keeping the indexer free of a
 * backend import dependency.
 *
 * Key format must stay in sync with `backend/src/cache/cacheKeys.ts`:
 *   `ipredict:v1:<entity>:<...parts>`
 *
 * When the cache namespace or version changes in the backend, update the
 * constants here to match.
 */

import type { RedisClient } from "./types.js";

// ---------------------------------------------------------------------------
// Key constants — mirrors backend/src/cache/cacheKeys.ts @ v1
// ---------------------------------------------------------------------------

const NS = "ipredict:v1";

function marketKey(id: number | string): string {
  return `${NS}:market:${id}`;
}

function marketsAllKey(): string {
  return `${NS}:markets:all`;
}

function marketsActiveKey(): string {
  return `${NS}:markets:active`;
}

function leaderboardKey(): string {
  return `${NS}:leaderboard:top20`;
}

function betsKey(marketId: number | string): string {
  return `${NS}:bets:${marketId}`;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/**
 * Invalidate caches stale after a market is **created**.
 *
 * Clears `markets:all` and `markets:active` so the next read includes the
 * new market.
 *
 * Event: `mkt:created`
 */
export async function invalidateOnMarketCreated(redis: RedisClient): Promise<void> {
  await redis.del(marketsAllKey(), marketsActiveKey());
}

/**
 * Invalidate caches stale after a **bet is placed**.
 *
 * Clears the individual market entry (odds/totals changed) and the
 * active-markets list.
 *
 * Event: `bet:placed`
 */
export async function invalidateOnBetPlaced(
  redis: RedisClient,
  marketId: number | string,
): Promise<void> {
  await redis.del(marketKey(marketId), marketsActiveKey());
}

/**
 * Invalidate caches stale after a market is **resolved**.
 *
 * Clears market, market lists, bets list, and leaderboard.
 *
 * Event: `mkt:resolved`
 */
export async function invalidateOnMarketResolved(
  redis: RedisClient,
  marketId: number | string,
): Promise<void> {
  await redis.del(
    marketKey(marketId),
    marketsAllKey(),
    marketsActiveKey(),
    betsKey(marketId),
    leaderboardKey(),
  );
}

/**
 * Invalidate caches stale after a market is **cancelled**.
 *
 * Event: `mkt:cancelled`
 */
export async function invalidateOnMarketCancelled(
  redis: RedisClient,
  marketId: number | string,
): Promise<void> {
  await redis.del(
    marketKey(marketId),
    marketsAllKey(),
    marketsActiveKey(),
  );
}

// ---------------------------------------------------------------------------
// Legacy aliases — kept for backward compatibility with existing handler
// imports.  New code should use the domain helpers above directly.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `invalidateOnMarketCreated` or `invalidateOnMarketResolved` /
 *             `invalidateOnMarketCancelled` instead.
 */
export async function invalidateMarketCache(
  redis: RedisClient,
  marketId: number,
): Promise<void> {
  await redis.del(
    marketKey(marketId),
    marketsAllKey(),
    marketsActiveKey(),
  );
}

/**
 * @deprecated Use `invalidateOnMarketResolved` instead which also clears
 *             market-level caches.
 */
export async function invalidateLeaderboardCache(redis: RedisClient): Promise<void> {
  await redis.del(leaderboardKey());
}
