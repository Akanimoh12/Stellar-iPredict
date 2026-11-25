/**
 * Cache key structure — the single module that knows how a key is shaped.
 *
 * Holds the versioned key builders, the TTLs that pair with them, and the
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
 * @see hitRate.ts for how the namespace label is counted
 */

export const CACHE_NAMESPACE = "ipredict" as const;

type CacheKeyPart = string | number;

export type CacheKey = string & { readonly __cacheKey: unique symbol };
export type MarketId = number | string;

let version = 1;

export function getVersion(): string {
  return `v${version}`;
}

export function bumpVersion(): string {
  version += 1;
  return getVersion();
}

export function resetVersion(): void {
  version = 1;
}

export function cacheKey(entity: string, ...parts: CacheKeyPart[]): CacheKey {
  return [CACHE_NAMESPACE, getVersion(), entity, ...parts]
    .map(String)
    .join(":") as CacheKey;
}

export function cacheKeyPattern(entity: string): string {
  return `${CACHE_NAMESPACE}:${getVersion()}:${entity}:*`;
}

export function marketKey(id: MarketId): CacheKey {
  return cacheKey("market", id);
}

export function marketsAllKey(): CacheKey {
  return cacheKey("markets", "all");
}

export function marketsActiveKey(): CacheKey {
  return cacheKey("markets", "active");
}

export function marketsListKey(
  filter: string,
  category: string | undefined,
  sort: string,
  page: number,
  limit: number
): CacheKey {
  return cacheKey(
    "markets",
    "list",
    filter,
    category ?? "all",
    sort,
    page,
    limit
  );
}

export function leaderboardKey(): CacheKey {
  return cacheKey("leaderboard", "top20");
}

export function statsKey(): CacheKey {
  return cacheKey("stats", "global");
}

export function statusKey(): CacheKey {
  return cacheKey("status", "feed");
}

export function betsKey(marketId: MarketId): CacheKey {
  return cacheKey("bets", marketId);
}

export function oddsKey(id: MarketId): CacheKey {
  return cacheKey("odds", id);
}

export const CACHE_TTLS = {
  marketsAll: 30,
  marketsActive: 15,
  market: 30,
  leaderboardTop20: 60,
  statsGlobal: 60,
  bets: 30,
  odds: 30,
  // Short: a status page polls often, and a stale health signal is worse than
  // an extra query. Long enough to absorb a burst of pollers.
  statusFeed: 15,
} as const;

export const CACHE_TTL_MS = {
  marketsAll: CACHE_TTLS.marketsAll * 1_000,
  marketsActive: CACHE_TTLS.marketsActive * 1_000,
  market: CACHE_TTLS.market * 1_000,
  leaderboardTop20: CACHE_TTLS.leaderboardTop20 * 1_000,
  statsGlobal: CACHE_TTLS.statsGlobal * 1_000,
  bets: CACHE_TTLS.bets * 1_000,
  odds: CACHE_TTLS.odds * 1_000,
  statusFeed: CACHE_TTLS.statusFeed * 1_000,
} as const;

export const CACHE_KEYS = {
  marketsAll: marketsAllKey,
  marketsActive: marketsActiveKey,
  market: marketKey,
  leaderboardTop20: leaderboardKey,
  statsGlobal: statsKey,
  bets: betsKey,
  odds: oddsKey,
  statusFeed: statusKey,
} as const;

export const CACHE_REGISTRY = {
  marketsAll: {
    key: marketsAllKey,
    build: marketsAllKey,
    ttl: CACHE_TTLS.marketsAll,
    ttlSeconds: CACHE_TTLS.marketsAll,
  },
  marketsActive: {
    key: marketsActiveKey,
    build: marketsActiveKey,
    ttl: CACHE_TTLS.marketsActive,
    ttlSeconds: CACHE_TTLS.marketsActive,
  },
  market: {
    key: marketKey,
    build: marketKey,
    ttl: CACHE_TTLS.market,
    ttlSeconds: CACHE_TTLS.market,
  },
  leaderboardTop20: {
    key: leaderboardKey,
    build: leaderboardKey,
    ttl: CACHE_TTLS.leaderboardTop20,
    ttlSeconds: CACHE_TTLS.leaderboardTop20,
  },
  statsGlobal: {
    key: statsKey,
    build: statsKey,
    ttl: CACHE_TTLS.statsGlobal,
    ttlSeconds: CACHE_TTLS.statsGlobal,
  },
  bets: {
    key: betsKey,
    build: betsKey,
    ttl: CACHE_TTLS.bets,
    ttlSeconds: CACHE_TTLS.bets,
  },
  odds: {
    key: oddsKey,
    build: oddsKey,
    ttl: CACHE_TTLS.odds,
    ttlSeconds: CACHE_TTLS.odds,
  },
} as const;

export const CACHE = CACHE_REGISTRY;

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * Every entity segment the key builders above can produce.
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
