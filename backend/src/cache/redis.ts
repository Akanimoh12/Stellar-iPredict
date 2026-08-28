import { Redis, RedisOptions } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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

/**
 * Single configured Redis client instance for the application.
 * DO NOT instantiate `new Redis()` elsewhere.
 */
export function getRedisClient(): Redis {
  if (client === null) {
    client = new Redis(REDIS_URL, options);
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
 */
export const cache = {
  /**
   * Retrieves and parses a JSON value.
   * Returns null if the key doesn't exist or is invalid JSON.
   */
  async get<T>(key: string): Promise<T | null> {
    const data = await getRedisClient().get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  },

  /**
   * Serializes to JSON and sets the value.
   * @param ttlSeconds Optional time-to-live in seconds.
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const redis = getRedisClient();
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await redis.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await redis.set(key, serialized);
    }
  },

  /**
   * Deletes a key.
   */
  async del(key: string): Promise<void> {
    await getRedisClient().del(key);
  },

  /**
   * Gracefully close the Redis connection.
   */
  async close(): Promise<void> {
    await getRedisClient().quit();
  },
};
