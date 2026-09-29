import { Redis, RedisOptions } from 'ioredis';
import { recordCacheHit, recordCacheMiss } from './hitRate.js';
import { getCircuitBreaker } from './circuitBreaker.js';
import { config } from '../config/index.js';
import { logCacheFailure } from './invalidate.js';

const options: RedisOptions = {
  // Reconnect strategy: exponential backoff up to 2 seconds
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  // Prevent unbounded queues if redis goes down hard
  maxRetriesPerRequest: 3,
  // Connect lazily so importing this module never opens a socket — important
  // for test environments without a running Redis (see src/test/fakeRedis.ts).
  lazyConnect: true,
  enableReadyCheck: true,
  autoResubscribe: false,
};

let client: Redis | null = null;

const circuit = getCircuitBreaker();

/**
 * Lazily constructs and returns the single configured Redis client.
 *
 * The client is created on first call (not at import time) and sourced
 * from the validated config module — see `config/index.ts`.  Importing this
 * module therefore opens no connection, which keeps tests fast and
 * deterministic without a running Redis server.
 *
 * DO NOT instantiate `new Redis()` elsewhere — use this function or
 * {@link setRedisClient} to inject a test double.
 */
export function getRedisClient(): Redis {
  if (client === null) {
    client = new Redis(config.REDIS_URL, options);
  }
  return client;
}

/**
 * Replaces the shared client — used by tests to inject a fake Redis
 * (see src/test/fakeRedis.ts) so cache behaviour is verified without a server.
 */
export function setRedisClient(fake: Redis): void {
  client = fake;
}

/**
 * Typed JSON helper for caching.
 *
 * Every method is circuit-breaker aware: when the breaker is OPEN the
 * operations degrade gracefully — `get` returns `null` (a cache miss,
 * so the caller falls back to the database), while `set` and `del` become
 * no-ops.  This means a Redis outage never propagates as a 5xx to the
 * client.
 */
export const cache = {
  /**
   * Retrieves and parses a JSON value.
   *
   * Returns `null` if the key doesn't exist, is invalid JSON, or Redis is
   * unavailable (circuit open or command rejected).  A `null` return is
   * treated as a cache miss by callers, so the loader / database path
   * runs transparently.
   */
  async get<T>(key: string): Promise<T | null> {
    if (!circuit.canAttempt()) {
      return null;
    }

    try {
      const data = await getRedisClient().get(key);
      circuit.recordSuccess();

      if (!data) {
        recordCacheMiss(key);
        return null;
      }
      try {
        const value = JSON.parse(data) as T;
        recordCacheHit(key);
        return value;
      } catch {
        // Unparseable entry: the caller gets null and goes to its source, so
        // this is a miss for `cache_hit_rate` purposes (issue #214).
        recordCacheMiss(key);
        return null;
      }
    } catch (error) {
      circuit.recordFailure();
      logCacheFailure(error);
      // Swallow — callers treat null as "go to the database".
      return null;
    }
  },

  /**
   * Serializes to JSON and sets the value.
   *
   * Failures are swallowed: a stale cache entry is better than a failed
   * request.  Redis will naturally evict old entries once it recovers.
   *
   * @param ttlSeconds Optional time-to-live in seconds.
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!circuit.canAttempt()) {
      return;
    }

    try {
      const redis = getRedisClient();
      const serialized = JSON.stringify(value);
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await redis.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await redis.set(key, serialized);
      }
      circuit.recordSuccess();
    } catch (error) {
      circuit.recordFailure();
      logCacheFailure(error);
      // Swallowed — cache writes are best-effort.
    }
  },

  /**
   * Deletes a key.
   *
   * Failures are swallowed: a failed invalidation means the next read
   * simply gets a stale entry for up to one TTL, which is acceptable
   * degradation under outage conditions.
   */
  async del(key: string): Promise<void> {
    if (!circuit.canAttempt()) {
      return;
    }

    try {
      await getRedisClient().del(key);
      circuit.recordSuccess();
    } catch (error) {
      circuit.recordFailure();
      logCacheFailure(error);
    }
  },

  /**
   * Gracefully close the Redis connection.
   */
  async close(): Promise<void> {
    if (client) {
      await client.quit();
    }
  },
};
