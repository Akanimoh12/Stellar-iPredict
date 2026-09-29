/**
 * Cache hit-rate accounting — issue #214.
 *
 * `cache_hit_rate` is one of the canonical application-health metrics in
 * `docs/ORACLE_AND_BACKEND.md#monitoring`. It answers a question the latency
 * histogram cannot: when p99 climbs, was it the database getting slower, or
 * the cache stopping working? A hit rate that falls off a cliff after a deploy
 * is almost always a key-shape change or a too-aggressive invalidation, and
 * without this metric that shows up only as unexplained load on Postgres.
 *
 * ## What counts as a lookup
 *
 * Every read that consults Redis before falling back to its loader:
 * {@link getOrSet} in `cacheAside.ts` and `cache.get` in `redis.ts`. A hit is
 * a stored value that was read back and parsed. A miss is a key that was
 * absent — or present but corrupt, because the caller still had to run the
 * loader, which is what the metric is measuring.
 *
 * Two lookups are deliberately *not* in these counters:
 *
 * - a value that parses to `null` — a cached "not found" — belongs to the
 *   negative cache and is counted in `negativeCache.ts`. Folding it in here
 *   would let a burst of 404s inflate the hit rate and mask a real cache
 *   regression, and it would make the negative cache's own behaviour
 *   invisible;
 * - a Redis *error*, which is already counted as a 5xx or handled by the
 *   caller. Folding it in here would make an outage look like a cold cache.
 *
 * ## Counters and a gauge
 *
 * `cache_hits_total` / `cache_misses_total` are monotonic counters, so
 * dashboards and alerts can compute a windowed rate:
 *
 * ```promql
 * sum(rate(cache_hits_total[5m]))
 *   / clamp_min(sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])), 1)
 * ```
 *
 * `cache_hit_rate` is the lifetime ratio — cheap to read, and the right number
 * for an at-a-glance panel. With no lookups yet it is `NaN` rather than `0`:
 * a freshly started backend has not achieved a 0% hit rate, and emitting 0
 * would fire a low-hit-rate alert on every deploy. PromQL comparisons against
 * NaN are false, so the alert stays quiet until there is real traffic.
 */

import {
  CACHE_ENTITIES,
  cacheNamespaceOf,
  type CacheNamespace,
} from "./cacheKeys.js";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * Cache key entities used as the `namespace` label.
 *
 * Re-exported from `cacheKeys.ts`, which owns the list because it owns the
 * key format. Every namespace in {@link CACHE_ENTITIES} gets its own
 * `cache_namespace_*` series, which is what makes a hit-rate drop
 * actionable: the aggregate tells you something changed, the per-namespace
 * breakdown tells you *which key structure* changed.
 */
export const CACHE_NAMESPACES = CACHE_ENTITIES;

export type { CacheNamespace };
export { cacheNamespaceOf };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Hit/miss counts for one namespace, or for the cache as a whole. */
export interface CacheCounts {
  readonly hits: number;
  readonly misses: number;
  /** `hits + misses`. */
  readonly lookups: number;
  /** `hits / lookups`, or `NaN` when there have been no lookups. */
  readonly hitRate: number;
}

export interface CacheStatsSnapshot extends CacheCounts {
  /** Per-namespace breakdown, sorted by namespace. */
  readonly byNamespace: readonly (CacheCounts & { readonly namespace: CacheNamespace })[];
}

interface MutableCounts {
  hits: number;
  misses: number;
}

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
 * Record a cache hit.
 *
 * @param key The cache key that was read. Only its namespace segment is kept.
 */
export function recordCacheHit(key: string): void {
  totals.hits++;
  bucket(cacheNamespaceOf(key)).hits++;
}

/**
 * Record a cache miss — an absent key, or a stored value that could not be
 * parsed and therefore sent the caller to its loader anyway.
 */
export function recordCacheMiss(key: string): void {
  totals.misses++;
  bucket(cacheNamespaceOf(key)).misses++;
}

/** `hits / (hits + misses)`, or `NaN` when nothing has been looked up. */
export function computeHitRate(hits: number, misses: number): number {
  const lookups = hits + misses;
  return lookups === 0 ? NaN : hits / lookups;
}

function toCounts(counts: MutableCounts): CacheCounts {
  return Object.freeze({
    hits: counts.hits,
    misses: counts.misses,
    lookups: counts.hits + counts.misses,
    hitRate: computeHitRate(counts.hits, counts.misses),
  });
}

/** Immutable snapshot of the whole registry. */
export function getCacheStats(): CacheStatsSnapshot {
  return Object.freeze({
    ...toCounts(totals),
    byNamespace: Object.freeze(
      [...perNamespace.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([namespace, counts]) => Object.freeze({ namespace, ...toCounts(counts) })),
    ),
  });
}

/** Lifetime hit rate, or `NaN` when nothing has been looked up. */
export function getCacheHitRate(): number {
  return computeHitRate(totals.hits, totals.misses);
}

/** Per-namespace hit rates, keyed by namespace name. Never empty — each known
 * namespace always appears, even with NaN when no lookups have occurred. */
export function getPerNamespaceHitRates(): Readonly<Record<CacheNamespace, number>> {
  const stats = getCacheStats();
  const result = {} as Record<CacheNamespace, number>;
  for (const ns of CACHE_NAMESPACES) {
    result[ns] = stats.byNamespace.find((s) => s.namespace === ns)?.hitRate ?? NaN;
  }
  result["other"] = stats.byNamespace.find((s) => s.namespace === "other")?.hitRate ?? NaN;
  return result;
}

/** Reset every counter. Used by tests and by rolling-window metric resets. */
export function resetCacheStats(): void {
  totals = { hits: 0, misses: 0 };
  perNamespace.clear();
}

// ---------------------------------------------------------------------------
// Prometheus serialization
// ---------------------------------------------------------------------------

import { serializeCircuitMetrics } from "./circuitBreaker.js";

/** `String(NaN)` is `"NaN"`, which the exposition format accepts as-is. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

/**
 * Serialize the cache metrics in Prometheus text exposition format.
 *
 * The unlabelled `cache_hit_rate` is the canonical series. The per-namespace
 * breakdown uses distinct metric names rather than a `namespace` label on the
 * same name — mixing labelled and unlabelled samples under one metric name is
 * an invalid exposition, and Prometheus rejects the entire scrape for it.
 */
export function serializeCacheMetrics(): string {
  const stats = getCacheStats();
  const lines: string[] = [];

  lines.push("# HELP cache_hit_rate Ratio of Redis cache hits to lookups since start (NaN before the first lookup)");
  lines.push("# TYPE cache_hit_rate gauge");
  lines.push(`cache_hit_rate ${formatValue(stats.hitRate)}`);

  lines.push("# HELP cache_hits_total Cache lookups served from Redis");
  lines.push("# TYPE cache_hits_total counter");
  lines.push(`cache_hits_total ${stats.hits}`);

  lines.push("# HELP cache_misses_total Cache lookups that fell through to the loader");
  lines.push("# TYPE cache_misses_total counter");
  lines.push(`cache_misses_total ${stats.misses}`);

  if (stats.byNamespace.length > 0) {
    lines.push("# HELP cache_namespace_hits_total Cache hits by key namespace");
    lines.push("# TYPE cache_namespace_hits_total counter");
    for (const entry of stats.byNamespace) {
      lines.push(`cache_namespace_hits_total{namespace="${entry.namespace}"} ${entry.hits}`);
    }

    lines.push("# HELP cache_namespace_misses_total Cache misses by key namespace");
    lines.push("# TYPE cache_namespace_misses_total counter");
    for (const entry of stats.byNamespace) {
      lines.push(`cache_namespace_misses_total{namespace="${entry.namespace}"} ${entry.misses}`);
    }

    lines.push("# HELP cache_namespace_hit_rate Ratio of hits to lookups per namespace");
    lines.push("# TYPE cache_namespace_hit_rate gauge");
    for (const entry of stats.byNamespace) {
      lines.push(`cache_namespace_hit_rate{namespace="${entry.namespace}"} ${formatValue(entry.hitRate)}`);
    }
  }

    // Circuit-breaker metrics — issue #481.
  lines.push(serializeCircuitMetrics());

  return lines.join("\n") + "\n";
}
