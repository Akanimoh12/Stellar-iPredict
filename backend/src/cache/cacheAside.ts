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

  // 1. Check Redis — but only if the circuit is closed or half-open.
  //    When OPEN, skip straight to the loader to avoid adding latency.
  if (circuit.canAttempt()) {
    try {
      const cached = await redis.get(key);
      circuit.recordSuccess();

      if (cached !== null) {
        try {
          const value = JSON.parse(cached) as T;
          recordCacheHit(key);
          return value;
        } catch {
          // Corrupt cache entry — fall through to refresh. Counted as a miss
          // below: the caller still pays for the loader, which is what
          // `cache_hit_rate` measures (issue #214).
        }
      }
      recordCacheMiss(key);
    } catch (error) {
      circuit.recordFailure();
      logCacheFailure(error);
      // Redis is unhealthy — fall through to the loader (degrade-to-db).
      recordCacheMiss(key);
    }
  } else {
    // Circuit is OPEN — skip Redis entirely to avoid adding latency.
    recordCacheMiss(key);
  }

  // 2. Cache miss (or degraded) — single-flight the entire load+store
  //    operation so concurrent callers share both the loader call and the setex.
  return withSingleFlight(key, "getOrSet", async () => {
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
