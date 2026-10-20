/**
 * Negative cache — briefly caches "not found" results to prevent repeated
 * database lookups for resources that do not exist.
 *
 * Without this, a bot or misbehaving client requesting `/api/v1/markets/99999`
 * in a tight loop would hammer the database with identical queries that always
 * return zero rows.  By caching the miss for a short TTL the DB is shielded
 * and the response latency drops to near-zero for repeated 404s.
 *
 * The cache uses lazy eviction: expired entries are pruned on read and a
 * periodic sweep runs at a configurable interval to bound memory.
 *
 * ## Metrics — tracked separately from `cache_hit_rate`
 *
 * Negative lookups are a different signal from ordinary cache lookups, so
 * they get their own metric family rather than being folded into
 * `cache_hits_total` / `cache_misses_total`:
 *
 * - a 404 storm would otherwise *raise* the hit rate (every cached not-found
 *   reads as a hit) and hide a real cache regression on the same namespace;
 * - conversely, when the negative cache stops working, only its own hit rate
 *   shows the database absorbing the repeated not-found queries.
 *
 * Two producers feed the counters, both counting a *lookup* — one consult of
 * "do we already know this is missing?":
 *
 * - this class: a hit is {@link NegativeCache.isCachedMiss} finding a live
 *   entry, a miss is it falling through to the source;
 * - `cacheAside.ts`: a hit is Redis returning a stored `null`, a miss is the
 *   loader having to run and answering `null`.
 *
 * Together they answer: of the requests for things that do not exist, what
 * fraction never touched the database?
 *
 * @see docs/ORACLE_AND_BACKEND.md §Caching Strategy
 */

import { cacheNamespaceOf, type CacheNamespace } from "./cacheKeys.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default time-to-live for negative cache entries (30 seconds). */
export const NEGATIVE_CACHE_TTL_MS = 30_000;

/** How often the background sweep prunes expired entries (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Timestamp (ms since epoch) when this entry expires. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Module-level metrics
// ---------------------------------------------------------------------------

/** Negative-cache lookup counts for one namespace, or for everything. */
export interface NegativeCacheCounts {
  readonly hits: number;
  readonly misses: number;
  /** `hits + misses`. */
  readonly lookups: number;
  /** `hits / lookups`, or `NaN` when nothing has been looked up. */
  readonly hitRate: number;
}

export interface NegativeCacheStatsSnapshot extends NegativeCacheCounts {
  /** Per-namespace breakdown, sorted by namespace. */
  readonly byNamespace: readonly (NegativeCacheCounts & {
    readonly namespace: CacheNamespace;
  })[];
}

interface MutableCounts {
  hits: number;
  misses: number;
}

/**
 * Process-wide counters.
 *
 * They live at module level rather than on the instances because the metrics
 * answer "how is negative caching behaving across the backend", and because
 * every producer — each {@link NegativeCache} instance and the cache-aside
 * read path — has to be able to contribute to the same answer. The per-instance
 * counters on {@link NegativeCache} remain, for callers that want their own.
 */
let totals: MutableCounts = { hits: 0, misses: 0 };
const perNamespace = new Map<CacheNamespace, MutableCounts>();

function bucket(namespace: CacheNamespace): MutableCounts {
  let counts = perNamespace.get(namespace);
  if (!counts) {
    counts = { hits: 0, misses: 0 };
    perNamespace.set(namespace, counts);
  }
  return counts;
}

/**
 * Record a negative-cache **hit** — the "this does not exist" answer was
 * served without consulting the database.
 *
 * @param key The key that was looked up. Only its namespace segment is kept.
 */
export function recordNegativeCacheHit(key: string): void {
  totals.hits++;
  bucket(cacheNamespaceOf(key)).hits++;
}

/**
 * Record a negative-cache **miss** — the lookup had to reach the database
 * (or its loader) to learn that the resource does not exist.
 *
 * @param key The key that was looked up. Only its namespace segment is kept.
 */
export function recordNegativeCacheMiss(key: string): void {
  totals.misses++;
  bucket(cacheNamespaceOf(key)).misses++;
}

/** `hits / (hits + misses)`, or `NaN` when nothing has been looked up. */
export function computeNegativeHitRate(hits: number, misses: number): number {
  const lookups = hits + misses;
  return lookups === 0 ? NaN : hits / lookups;
}

function toCounts(counts: MutableCounts): NegativeCacheCounts {
  return Object.freeze({
    hits: counts.hits,
    misses: counts.misses,
    lookups: counts.hits + counts.misses,
    hitRate: computeNegativeHitRate(counts.hits, counts.misses),
  });
}

/** Immutable snapshot of every negative-cache producer in this process. */
export function getNegativeCacheStats(): NegativeCacheStatsSnapshot {
  return Object.freeze({
    ...toCounts(totals),
    byNamespace: Object.freeze(
      [...perNamespace.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([namespace, counts]) =>
          Object.freeze({ namespace, ...toCounts(counts) }),
        ),
    ),
  });
}

/** Lifetime negative-cache hit rate, or `NaN` when nothing has been looked up. */
export function getNegativeCacheHitRate(): number {
  return computeNegativeHitRate(totals.hits, totals.misses);
}

/** Reset every negative-cache counter. Used by tests. */
export function resetNegativeCacheStats(): void {
  totals = { hits: 0, misses: 0 };
  perNamespace.clear();
}

/**
 * Serialize the negative-cache metrics in Prometheus text exposition format.
 *
 * Mirrors `serializeCacheMetrics()`: unlabelled counters plus a gauge for the
 * at-a-glance panel, and a separate `*_namespace_*` set for the breakdown, so
 * labelled and unlabelled samples never share a metric name. The gauge is
 * `NaN` before the first lookup for the same reason `cache_hit_rate` is —
 * "no negative lookups yet" is not a 0% hit rate, and a 0 would make a fresh
 * deploy look like a collapsed negative cache.
 */
export function serializeNegativeCacheMetrics(): string {
  const stats = getNegativeCacheStats();
  const lines: string[] = [];

  lines.push(
    "# HELP negative_cache_hit_rate Ratio of negative-cache hits to negative lookups since start (NaN before the first lookup)",
  );
  lines.push("# TYPE negative_cache_hit_rate gauge");
  lines.push(`negative_cache_hit_rate ${formatValue(stats.hitRate)}`);

  lines.push(
    "# HELP negative_cache_hits_total Not-found lookups served without a database query",
  );
  lines.push("# TYPE negative_cache_hits_total counter");
  lines.push(`negative_cache_hits_total ${stats.hits}`);

  lines.push(
    "# HELP negative_cache_misses_total Not-found lookups that had to reach the database",
  );
  lines.push("# TYPE negative_cache_misses_total counter");
  lines.push(`negative_cache_misses_total ${stats.misses}`);

  if (stats.byNamespace.length > 0) {
    lines.push(
      "# HELP negative_cache_namespace_hits_total Negative-cache hits by key namespace",
    );
    lines.push("# TYPE negative_cache_namespace_hits_total counter");
    for (const entry of stats.byNamespace) {
      lines.push(
        `negative_cache_namespace_hits_total{namespace="${entry.namespace}"} ${entry.hits}`,
      );
    }

    lines.push(
      "# HELP negative_cache_namespace_misses_total Negative-cache misses by key namespace",
    );
    lines.push("# TYPE negative_cache_namespace_misses_total counter");
    for (const entry of stats.byNamespace) {
      lines.push(
        `negative_cache_namespace_misses_total{namespace="${entry.namespace}"} ${entry.misses}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

/** `String(NaN)` is `"NaN"`, which the exposition format accepts as-is. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

// ---------------------------------------------------------------------------
// NegativeCache
// ---------------------------------------------------------------------------

/**
 * In-memory TTL cache for recording "resource not found" responses.
 *
 * Each instance maintains its own store and sweep timer.  Call
 * {@link destroy} before discarding an instance to clear the timer.
 */
export class NegativeCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private hits = 0;
  private misses = 0;

  constructor(defaultTtlMs: number = NEGATIVE_CACHE_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
    this.startSweep();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Record a cache miss for {@link key}.  Subsequent calls to
   * {@link isCachedMiss} will return `true` until the TTL elapses.
   */
  markMiss(key: string, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, { expiresAt: Date.now() + ttl });
  }

  /**
   * Returns `true` if {@link key} is a cached miss that has not yet expired.
   * Lazily evicts the entry when it is stale.
   *
   * Every call is a negative-cache **lookup** and is counted in the
   * module-level metrics as well as on the instance: `true` is a hit (the
   * database was not needed), `false` is a miss (the caller still has to
   * ask the source of truth).
   */
  isCachedMiss(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) {
      this.misses += 1;
      recordNegativeCacheMiss(key);
      return false;
    }

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      this.misses += 1;
      recordNegativeCacheMiss(key);
      return false;
    }

    this.hits += 1;
    recordNegativeCacheHit(key);
    return true;
  }

  /**
   * Returns cache metrics including cumulative hits, misses, and the hit rate.
   *
   * Scoped to this instance. For the process-wide numbers that feed
   * `negative_cache_hit_rate`, use {@link getNegativeCacheStats}.
   * Unlike the module-level gauge this returns `0` with no lookups, which is
   * the long-standing contract of this method — tests and callers treat an
   * empty instance as having a 0% hit rate.
   */
  getMetrics(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  /**
   * Remove a specific entry — call when the resource is created so that the
   * next lookup goes through to the database.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Flush every entry. */
  clear(): void {
    this.store.clear();
  }

  /** Number of (potentially expired) entries currently in the store. */
  get size(): number {
    return this.store.size;
  }

  /** Stop the background sweep timer.  Safe to call multiple times. */
  destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Remove all expired entries in one pass. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  private startSweep(): void {
    // unref() ensures the timer does not prevent Node from exiting.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }
}
