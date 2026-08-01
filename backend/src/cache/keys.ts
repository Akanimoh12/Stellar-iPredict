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

export function betsKey(marketId: MarketId): CacheKey {
  return cacheKey("bets", marketId);
}

export const CACHE_TTLS = {
  marketsAll: 30,
  marketsActive: 15,
  market: 30,
  leaderboardTop20: 60,
  statsGlobal: 60,
  bets: 30,
} as const;

export const CACHE_TTL_MS = {
  marketsAll: CACHE_TTLS.marketsAll * 1_000,
  marketsActive: CACHE_TTLS.marketsActive * 1_000,
  market: CACHE_TTLS.market * 1_000,
  leaderboardTop20: CACHE_TTLS.leaderboardTop20 * 1_000,
  statsGlobal: CACHE_TTLS.statsGlobal * 1_000,
  bets: CACHE_TTLS.bets * 1_000,
} as const;

export const CACHE_KEYS = {
  marketsAll: marketsAllKey,
  marketsActive: marketsActiveKey,
  market: marketKey,
  leaderboardTop20: leaderboardKey,
  statsGlobal: statsKey,
  bets: betsKey,
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
} as const;

export const CACHE = CACHE_REGISTRY;
