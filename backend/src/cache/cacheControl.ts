/**
 * Cache-Control header builders and per-route caching policy — issues #480, #1013.
 *
 * Every Cache-Control header is derived from the same TTL constant used by
 * the server-side Redis cache-aside layer. Changing a TTL in
 * `cacheKeys.ts` (`CACHE_TTLS`) automatically changes the header value, so
 * the two can never drift apart.
 *
 * ## Header semantics
 *
 * - `cacheControlPublic(ttl)` — the response is identical for every client
 *   and safe for a shared CDN to store. `max-age` mirrors the Redis TTL.
 *
 * - `cacheControlPrivate(ttl)` — the response contains user-specific data;
 *   it may be stored only in the requesting browser's cache, never in a
 *   shared intermediary.
 *
 * - `cacheControlNoStore()` — the response must never be cached at all
 *   (used for health checks, live feeds, profiles, and state-mutating requests).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CACHE_TTLS } from "./cacheKeys.js";

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

/**
 * Build a `Cache-Control: public` header string for shared-cacheable data.
 *
 * The `max-age` is derived directly from the server-side Redis TTL so the
 * header and the cache entry always agree. A `stale-while-revalidate`
 * window equal to the TTL gives CDNs a grace period to serve stale data
 * during a backend blip without ever returning a stale entry past
 * `max-age + stale-while-revalidate`.
 */
export function cacheControlPublic(ttlSeconds: number): string {
  return `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`;
}

/**
 * Build a `Cache-Control: private` header string for user-specific data.
 *
 * `private` ensures the response is stored only in the browser, never in a
 * shared CDN. `max-age` is kept short so the user sees updates within the
 * configured TTL.
 */
export function cacheControlPrivate(ttlSeconds: number): string {
  return `private, max-age=${ttlSeconds}`;
}

/**
 * Build a `Cache-Control: no-store` header string for data that must never
 * be cached — e.g. health checks, dynamic SSE feeds, and user profiles.
 */
export function cacheControlNoStore(): string {
  return "no-store, no-cache, must-revalidate, private";
}

// ---------------------------------------------------------------------------
// Per-Route Policy Definitions (#1013)
// ---------------------------------------------------------------------------

export interface RouteCachePolicy {
  readonly pattern: RegExp;
  readonly getHeader: () => string;
}

/** Canonical per-route caching policies */
export const ROUTE_CACHE_POLICIES: readonly RouteCachePolicy[] = Object.freeze([
  // Health & Monitoring Probes — never cache
  {
    pattern: /^\/(healthz|readyz|livez)$/,
    getHeader: cacheControlNoStore,
  },
  // Real-time live feeds (SSE)
  {
    pattern: /^\/api\/markets\/live(\/.*)?$/,
    getHeader: () => "no-cache, no-transform",
  },
  {
    pattern: /^\/api\/markets\/\d+\/live$/,
    getHeader: () => "no-cache, no-transform",
  },
  // Public Stats
  {
    pattern: /^\/api\/stats$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.statsGlobal),
  },
  // Status Feed
  {
    pattern: /^\/(status|api\/status)$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.statusFeed),
  },
  // Leaderboard
  {
    pattern: /^\/api\/leaderboard$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.leaderboardTop20),
  },
  // Market Resolution Status
  {
    pattern: /^\/(resolution-status|api\/markets\/resolution-status)$/,
    getHeader: () => cacheControlPublic(30),
  },
  // Market Unmappable Candidates
  {
    pattern: /^\/api\/markets\/unmappable$/,
    getHeader: () => cacheControlPublic(60),
  },
  // Market Odds
  {
    pattern: /^\/api\/markets\/\d+\/odds$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.odds),
  },
  // Market Bets
  {
    pattern: /^\/api\/markets\/\d+\/bets$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.bets),
  },
  // Market Detail
  {
    pattern: /^\/api\/markets\/\d+$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.market),
  },
  // Market List
  {
    pattern: /^\/api\/markets$/,
    getHeader: () => cacheControlPublic(CACHE_TTLS.marketsAll),
  },
  // User Profile and Profile Bets — private user data, strictly no-store
  {
    pattern: /^\/api\/v1\/profile\/[^/]+(\/bets)?$/,
    getHeader: cacheControlNoStore,
  },
  // OpenAPI Documentation
  {
    pattern: /^\/api\/docs$/,
    getHeader: () => cacheControlPublic(3600),
  },
]);

/**
 * Derives the appropriate Cache-Control header string for a given request path and method.
 *
 * Mutation methods (POST, PUT, DELETE, PATCH) and unrecognized paths default to `no-store`
 * to protect against unintentional caching of writes or unknown states.
 */
export function getRouteCacheControl(url: string, method: string = "GET"): string {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    return cacheControlNoStore();
  }

  // Strip query string and trailing slash if not root
  const cleanPath = url.split("?")[0].replace(/\/+$/, "") || "/";

  for (const policy of ROUTE_CACHE_POLICIES) {
    if (policy.pattern.test(cleanPath)) {
      return policy.getHeader();
    }
  }

  return cacheControlNoStore();
}

/**
 * Fastify hook that ensures every response carries an appropriate Cache-Control header (#1013).
 *
 * If a route handler explicitly set a Cache-Control header (e.g. customized TTL), that header
 * is preserved. Otherwise, the per-route policy automatically applies the appropriate directive.
 */
export function registerCacheControlHook(server: FastifyInstance): void {
  server.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    const existing = reply.getHeader("cache-control");
    if (!existing) {
      const header = getRouteCacheControl(request.url, request.method);
      reply.header("Cache-Control", header);
    }
  });
}
