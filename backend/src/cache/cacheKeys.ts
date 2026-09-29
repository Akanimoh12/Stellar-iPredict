/**
 * Cache key structure — the module that knows how a key is shaped.
 *
 * Re-exports the versioned key builders from `keys.ts` and defines the
 * **namespace contract**: the closed set of entity segments a production key
 * can carry, and the derivation of a metric label from an arbitrary key.
 *
 * The namespace list lives here rather than in the metrics module because it
 * is a property of the key format (`ipredict:v<n>:<entity>:<parts…>`), and
 * because the two must not drift: adding a key builder without adding its
 * entity here would silently fold that endpoint's traffic into `other`, which
 * is exactly the "aggregate looks fine, one key structure broke" failure the
 * per-namespace hit rate exists to catch.
 *
 * @see keys.ts for the builders themselves
 * @see hitRate.ts for how the namespace label is counted
 */

export * from "./keys.js";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * Every entity segment the key builders in `keys.ts` can produce.
 *
 * Closed on purpose: the entity becomes a Prometheus label, and keys embed
 * market ids — anything not on this list is bucketed as `other` rather than
 * becoming one series per key.
 */
export const CACHE_ENTITIES = [
  "market",
  "markets",
  "leaderboard",
  "stats",
  "status",
  "bets",
  "odds",
] as const;

/** One of {@link CACHE_ENTITIES}. */
export type CacheEntity = (typeof CACHE_ENTITIES)[number];

/**
 * The `namespace` label used by the cache metrics: a known entity, or
 * `other` for anything hand-built or from a module that predates this list.
 */
export type CacheNamespace = CacheEntity | "other";

const KNOWN_ENTITIES = new Set<string>(CACHE_ENTITIES);

/**
 * Extract the namespace from a cache key.
 *
 * `cacheKey()` builds `ipredict:v<n>:<entity>:<parts…>`, so the entity is the
 * third colon-separated segment. Keys that do not have that shape — a legacy
 * key, a hand-built key, or `""` — are `other`.
 *
 * ```ts
 * cacheNamespaceOf(marketKey(7));   // "market"
 * cacheNamespaceOf("legacy-key");   // "other"
 * ```
 */
export function cacheNamespaceOf(key: string): CacheNamespace {
  const segments = key.split(":", 3);
  const entity = segments.length === 3 ? segments[2] : "";
  return KNOWN_ENTITIES.has(entity) ? (entity as CacheEntity) : "other";
}
