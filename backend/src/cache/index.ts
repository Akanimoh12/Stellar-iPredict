/**
 * Cache module barrel export.
 *
 * Re-exports every public API from the cache sub-modules so consumers can
 * import from `../cache/index.js` (or just `../cache/`) without knowing the
 * internal file layout.
 */

export {
  CACHE_NAMESPACE,
  getVersion,
  bumpVersion,
  resetVersion,
  cacheKey,
  cacheKeyPattern,
  marketKey,
  marketsAllKey,
  marketsActiveKey,
  marketsListKey,
  leaderboardKey,
  statsKey,
  betsKey,
} from "./cacheKeys.js";

export {
  SlidingWindowStore,
  resolveRateLimit,
  registerRateLimiter,
  RATE_LIMITS,
  type RateLimitConfig,
  type RateLimitStore,
  type RateLimitResult,
} from "./rateLimiter.js";

export { RedisSlidingWindowStore } from "./rateLimiterRedis.js";
export { NegativeCache, NEGATIVE_CACHE_TTL_MS } from "./negativeCache.js";
export { getOrSet, withSingleFlight } from "./cacheAside.js";
export {
  invalidate,
  invalidateOnMarketCreated,
  invalidateOnBetPlaced,
  invalidateOnMarketResolved,
  invalidateOnMarketCancelled,
} from "./invalidate.js";
