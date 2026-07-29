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
};

/**
 * Single configured Redis client instance for the application.
 * DO NOT instantiate `new Redis()` elsewhere.
 */
export const redisClient = new Redis(REDIS_URL, options);

/**
 * Typed JSON helper for caching.
 */
export const cache = {
  /**
   * Retrieves and parses a JSON value.
   * Returns null if the key doesn't exist or is invalid JSON.
   */
  async get<T>(key: string): Promise<T | null> {
    const data = await redisClient.get(key);
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
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await redisClient.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await redisClient.set(key, serialized);
    }
  },

  /**
   * Deletes a key.
   */
  async del(key: string): Promise<void> {
    await redisClient.del(key);
  },

  /**
   * Gracefully close the Redis connection.
   */
  async close(): Promise<void> {
    await redisClient.quit();
  },
};
