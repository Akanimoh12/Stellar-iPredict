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
