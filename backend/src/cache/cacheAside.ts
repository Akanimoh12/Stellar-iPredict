/**
 * Cache-aside helper — transparently caches expensive reads in Redis.
 *
 * ## Pattern
 *
 * ```ts
 * const market = await getOrSet(redis, marketKey(id), 30, () =>
 *   db.query("SELECT * FROM markets WHERE id = $1", [id])
 * );
 * ```
 *
 * On a **cache hit** the stored JSON value is parsed and returned without
 * calling the loader.  On a **cache miss** the loader is called, its result
 * is serialised to JSON and written to Redis with a TTL (via `SETEX`), and
 * then returned.
 *
 * ## Stampede protection (single-flight)
 *
 * When N concurrent callers request the same key that isn't cached yet,
 * only the first caller invokes the loader.  Every other caller waits for
 * that same in-flight promise, so the loader runs exactly once per cache
 * miss regardless of concurrency. This is process-local; deployments with
 * several instances need distributed coordination for a global guarantee.
 *
 * ## Serialisation
 *
 * Values are stored as JSON strings.  The `loader` can return any value
 * that is `JSON.stringify`-able.  When the cached value is read back it
 * goes through `JSON.parse`, so the returned type is the same as the
 * loader's return type.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Caching Strategy
 */

import type { Redis } from "ioredis";
import { recordCacheHit, recordCacheMiss } from "./hitRate.js";
import {
  recordNegativeCacheHit,
  recordNegativeCacheMiss,
} from "./negativeCache.js";
import { getCircuitBreaker } from "./circuitBreaker.js";
import { logCacheFailure } from "./invalidate.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read-through cache: return the value at `key` if it exists in Redis,
 * otherwise call `loader`, store the result with `ttl` seconds, and return it.
 *
 * Stampede-safe: concurrent callers for the same key share a single loader
 * execution.
 *
 * ## Accounting
 *
 * Every call that actually got an answer out of Redis is recorded exactly
 * once, in exactly one metric family (see `hitRate.ts` and `negativeCache.ts`):
 *
 * | Redis said        | loader answered | counted as                        |
 * |-------------------|-----------------|-----------------------------------|
 * | a value           | —               | cache hit                         |
 * | a stored `null`   | —               | negative-cache hit                |
 * | absent / corrupt  | value           | cache miss                        |
 * | absent / corrupt  | `null`          | negative-cache miss               |
 * | error / skipped   | —               | nothing (not a lookup)            |
 *
 * The miss is classified *after* the loader settles, because before it runs
 * an absent key could turn out to be either a real record or a not-found, and
 * mixing the two would let a 404 storm move the ordinary hit rate. A loader
 * that rejects counts as an ordinary miss — the cache did not serve the read.
 *
 * @param redis   An ioredis client (or compatible).
 * @param key     Cache key — use `cacheKey()` from `cacheKeys.ts` for
 *                versioned, namespaced keys.
 * @param ttlSec  Time-to-live in seconds.  After this period the key expires
 *                and the next call will invoke the loader again.
 * @param loader  Async function that produces the value to cache.  Called at
 *                most once per cache miss.
 *
 * @returns The cached or freshly-loaded value (JSON-round-tripped).
 *
  * @throws Any error thrown by `loader` propagates to the caller.
 *       Redis errors do **not** propagate — they are counted by the circuit
 *       breaker and the loader is called instead (degrade-to-db).
 */
export async function getOrSet<T>(
  redis: Redis,
  key: string,
  ttlSec: number,
  loader: () => Promise<T>
): Promise<T> {
  const circuit = getCircuitBreaker();

  // Whether this call got an answer out of Redis. A circuit-open skip or a
  // rejected Redis command is not a lookup (issue #214): the cache never had
  // the chance to serve anything, so counting it would turn a Redis outage
  // into a cache-miss incident on top of the real one.
  let consultedRedis = false;

  // 1. Check Redis — but only if the circuit is closed or half-open.
  //    When OPEN, skip straight to the loader to avoid adding latency.
  if (circuit.canAttempt()) {
    try {
      const cached = await redis.get(key);
      circuit.recordSuccess();
      consultedRedis = true;

      if (cached !== null) {
        try {
          const value = JSON.parse(cached) as T;
          if (value === null) {
            // A stored "not found" — the negative cache answered, no loader ran.
            recordNegativeCacheHit(key);
          } else {
            recordCacheHit(key);
          }
          return value;
        } catch {
          // Corrupt cache entry — fall through to refresh. Classified below,
          // against the value the loader produces.
        }
      }
    } catch (error) {
      circuit.recordFailure();
      logCacheFailure(error);
      // Redis is unhealthy — fall through to the loader (degrade-to-db).
      // A Redis error is not counted as a miss (issue #214).
    }
  }

  // 2. Cache miss (or degraded) — single-flight the entire load+store
  //    operation so concurrent callers share both the loader call and the setex.
  const loading = withSingleFlight(key, "getOrSet", async () => {
    const value = await loader();

    // 3. Store in Redis.  If the write fails we still return the value —
    //    the next request will simply hit the loader again.
    const serialised = JSON.stringify(value);
    if (serialised !== undefined) {
      try {
        await redis.setex(key, ttlSec, serialised);
        circuit.recordSuccess();
      } catch (error) {
        circuit.recordFailure();
        logCacheFailure(error);
        // Swallow here so callers always receive their data even when the
        // cache is unwriteable.
      }
    }

    return value;
  });

  if (!consultedRedis) {
    return loading;
  }

  // 4. Classify this caller's miss once the answer is known. Every caller
  //    that consulted Redis gets its own count, including callers that
  //    coalesced onto one in-flight loader.
  return loading.then(
    (value) => {
      if (value === null) {
        recordNegativeCacheMiss(key);
      } else {
        recordCacheMiss(key);
      }
      return value;
    },
    (error) => {
      recordCacheMiss(key);
      throw error;
    }
  );
}

// ---------------------------------------------------------------------------
// Single-flight deduplication
// ---------------------------------------------------------------------------

/**
 * In-flight loader promises, keyed by `"scope:cacheKey"`.
 *
 * Entries are removed as soon as the loader settles so memory is bounded by
 * the number of *concurrently in-flight* misses, not the total number of
 * cache keys ever accessed.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Ensure {@link fn} executes at most once per `cacheKey` across concurrent
 * callers.  Every caller receives the same promise.
 *
 * @param scope    Namespace to prevent collisions across unrelated subsystems
 *                 (e.g. `"getOrSet"`).
 * @param cacheKey The cache key being loaded.
 * @param fn       The loader to deduplicate.
 * @internal Exported for testing only.
 */
export async function withSingleFlight<T>(
  cacheKey: string,
  scope: string,
  fn: () => Promise<T>
): Promise<T> {
  const dedupeKey = `${scope}:${cacheKey}`;

  const existing = inFlight.get(dedupeKey);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    inFlight.delete(dedupeKey);
  });

  inFlight.set(dedupeKey, promise);
  return promise as Promise<T>;
}
