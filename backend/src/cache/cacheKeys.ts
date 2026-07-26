/**
 * Cache key versioning and namespace utilities.
 *
 * Every cache key is prefixed with a namespace and version so that:
 *   1. Keys from different deployments or services never collide.
 *   2. Bumping the version logically invalidates every existing key at once
 *      without issuing individual DEL commands — old-version keys simply expire
 *      on their own while new reads write to the new prefix.
 *
 * Key format: `{namespace}:{version}:{entity}:{...parts}`
 *
 * Example: `ipredict:v1:market:42`
 *
 * @see docs/ORACLE_AND_BACKEND.md §Caching Strategy
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Application-level namespace, preventing collisions in shared stores. */
export const CACHE_NAMESPACE = "ipredict";

/**
 * Current cache key version.  Mutated only by {@link bumpVersion} — in
 * production the version would typically come from config or be bumped during
 * a deployment migration, but the in-memory default is sufficient for the
 * current backend which has no persistent cache store yet.
 */
let currentVersion = 1;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current version string (e.g. `"v1"`).
 */
export function getVersion(): string {
  return `v${currentVersion}`;
}

/**
 * Increment the version counter, logically invalidating every key produced
 * prior to the bump.  Returns the new version string.
 */
export function bumpVersion(): string {
  currentVersion += 1;
  return getVersion();
}

/**
 * Reset the version back to 1 — only useful in tests.
 * @internal
 */
export function resetVersion(): void {
  currentVersion = 1;
}

/**
 * Build an arbitrary cache key under the current namespace and version.
 *
 * ```ts
 * cacheKey("market", 42)       // "ipredict:v1:market:42"
 * cacheKey("markets", "all")   // "ipredict:v1:markets:all"
 * ```
 */
export function cacheKey(entity: string, ...parts: (string | number)[]): string {
  const segments = [CACHE_NAMESPACE, getVersion(), entity, ...parts.map(String)];
  return segments.join(":");
}

/**
 * Build a glob-style pattern that matches every key for the given entity
 * under the current version, suitable for Redis `KEYS` / `SCAN`.
 *
 * ```ts
 * cacheKeyPattern("market")  // "ipredict:v1:market:*"
 * ```
 */
export function cacheKeyPattern(entity: string): string {
  return `${CACHE_NAMESPACE}:${getVersion()}:${entity}:*`;
}

// ---------------------------------------------------------------------------
// Typed key builders — mirror the cache table in ORACLE_AND_BACKEND.md
// ---------------------------------------------------------------------------

/** Key for a single market: `ipredict:v1:market:{id}` */
export function marketKey(id: number | string): string {
  return cacheKey("market", id);
}

/** Key for the full market list: `ipredict:v1:markets:all` */
export function marketsAllKey(): string {
  return cacheKey("markets", "all");
}

/** Key for active markets only: `ipredict:v1:markets:active` */
export function marketsActiveKey(): string {
  return cacheKey("markets", "active");
}

/** Key for the top-N leaderboard snapshot: `ipredict:v1:leaderboard:top20` */
export function leaderboardKey(): string {
  return cacheKey("leaderboard", "top20");
}

/** Key for global platform statistics: `ipredict:v1:stats:global` */
export function statsKey(): string {
  return cacheKey("stats", "global");
}

/** Key for a market's bet list: `ipredict:v1:bets:{marketId}` */
export function betsKey(marketId: number | string): string {
  return cacheKey("bets", marketId);
}
