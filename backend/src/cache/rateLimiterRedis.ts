/**
 * Redis-backed sliding-window rate limiter.
 *
 * The store uses a sorted set per rate-limit key where each member is a
 * unique request identifier and the score is the request timestamp in
 * milliseconds.  A Lua script atomically prunes expired entries, checks
 * the cardinality against the limit, and either admits or denies the
 * request.  Keys carry a TTL so idle windows are evicted without manual
 * cleanup.
 *
 * This implementation is a drop-in async replacement for the in-memory
 * {@link SlidingWindowStore} shipped in `rateLimiter.ts` — both implement
 * {@link RateLimitStore} and the Fastify hook in `registerRateLimiter`
 * handles sync *and* async stores transparently.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Rate Limiting
 */

import type { Redis } from "ioredis";
import { cacheKey } from "./cacheKeys.js";
import type { RateLimitResult, RateLimitStore } from "./rateLimiter.js";

// ---------------------------------------------------------------------------
// Lua script
// ---------------------------------------------------------------------------

/**
 * Atomic sliding-window check-and-increment.
 *
 * KEYS[1] — Redis key for the sorted set
 * ARGV[1] — current timestamp (ms)
 * ARGV[2] — window size (ms)
 * ARGV[3] — maximum requests in the window
 * ARGV[4] — unique member identifier for this request
 *
 * Returns a 3-element array: [allowed, remaining, resetMs]
 *   allowed:    1 if the request is within budget, 0 if blocked
 *   remaining:  how many requests remain in the window (0 when blocked)
 *   resetMs:    milliseconds until the oldest entry expires
 */
const SLIDING_WINDOW_SCRIPT = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]
local cutoff   = now - windowMs

-- Evict entries that have fallen out of the window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = 0
  if oldest[2] then
    resetMs = tonumber(oldest[2]) + windowMs - now
  end
  if resetMs < 0 then resetMs = 0 end
  return {0, 0, resetMs}
end

redis.call('ZADD', key, now, member)

-- TTL covers the window plus a small grace period so the key is never removed
-- while it still holds relevant data.  +2 s is plenty for clock drift.
redis.call('EXPIRE', key, math.ceil(windowMs / 1000) + 2)

local newRemaining = limit - count - 1
local oldestList = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetMs = 0
if oldestList[2] then
  resetMs = tonumber(oldestList[2]) + windowMs - now
end
if resetMs < 0 then resetMs = 0 end

return {1, newRemaining, resetMs}
`;

// ---------------------------------------------------------------------------
// Key prefix
// ---------------------------------------------------------------------------

/** Namespace shared with other cache keys — see {@link cacheKey}. */
const RATE_LIMIT_ENTITY = "ratelimit";

// ---------------------------------------------------------------------------
// RedisSlidingWindowStore
// ---------------------------------------------------------------------------

/**
 * Per-IP sliding-window rate-limiter backed by Redis sorted sets.
 *
 * Usage:
 * ```ts
 * import { getRedisClient } from "../db/redis.js";
 *
 * const store = new RedisSlidingWindowStore(getRedisClient());
 * const result = await store.increment("192.168.1.1:GET:/api/markets", 60, 60);
 * if (!result.allowed) { /* 429 *​/ }
 * ```
 */
export class RedisSlidingWindowStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Record a request and return its admission status.
   *
   * The operation is atomic thanks to the embedded Lua script sent via
   * `EVAL`.  We use `EVAL` (not `EVALSHA`) so there is no cached-SHA
   * lifecycle to manage — the full script is sent on every call, which is
   * acceptable for a rate limiter whose throughput is bounded by the
   * number of HTTP requests the server can field anyway.
   *
   * @param key       Composite identifier, e.g. `"ip:method:path"`.
   * @param limit     Max requests allowed within the window.
   * @param windowSec Window duration in seconds.
   */
  async increment(
    key: string,
    limit: number,
    windowSec: number
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSec * 1_000;
    // A unique member prevents two requests that land on the same
    // millisecond from colliding inside the sorted set.
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const redisKey = cacheKey(RATE_LIMIT_ENTITY, key);

    // ioredis returns the Lua array as an array of numbers.
    const result = (await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      redisKey,
      now,
      windowMs,
      limit,
      member
    )) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      resetMs: result[2],
    };
  }

  /**
   * No-op — the Redis connection is shared across the process and its
   * lifecycle is managed by {@link getRedisClient} / {@link closeRedis}
   * in `db/redis.ts`.
   */
  async destroy(): Promise<void> {
    // intentionally empty
  }
}
