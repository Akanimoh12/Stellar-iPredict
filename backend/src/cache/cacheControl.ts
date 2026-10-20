/**
 * Cache-Control header builders — issue #480.
 *
 * Every Cache-Control header is derived from the same TTL constant used by
 * the server-side Redis cache-aside layer.  Changing a TTL in
 * `cacheKeys.ts` (`CACHE_TTLS`) automatically changes the header value, so
 * the two can never drift apart.
 *
 * ## Header semantics
 *
 * - `cacheControlPublic(ttl)` — the response is identical for every client
 *   and safe for a shared CDN to store.  `max-age` mirrors the Redis TTL.
 *
 * - `cacheControlPrivate(ttl)` — the response contains user-specific data;
 *   it may be stored only in the requesting browser's cache, never in a
 *   shared intermediary.
 *
 * - `cacheControlNoStore()` — the response must never be cached at all
 *   (used for profile data that exposes per-user betting history).
 *
 * ## OpenAPI
 *
 * Each route that sets a Cache-Control header should document the header
 * in its route `schema` so the generated spec stays in sync:
 *
 * ```ts
 * response: {
 *   200: {
 *     type: "object",
 *     headers: {
 *       "Cache-Control": {
 *         type: "string",
 *         description: "Cache directives for this response",
 *         example: "public, max-age=30",
 *       },
 *     },
 *     properties: { ... },
 *   },
 * },
 * ```
 */

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

/**
 * Build a `Cache-Control: public` header string for shared-cacheable data.
 *
 * The `max-age` is derived directly from the server-side Redis TTL so the
 * header and the cache entry always agree.  A `stale-while-revalidate`
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
 * shared CDN.  `max-age` is kept short so the user sees updates within the
 * configured TTL.
 */
export function cacheControlPrivate(ttlSeconds: number): string {
  return `private, max-age=${ttlSeconds}`;
}

/**
 * Build a `Cache-Control: no-store` header string for data that must never
 * be cached — e.g. a user's profile, which aggregates betting history tied
 * to a specific Stellar address.
 *
 * A public cache that stored this response would leak one user's data to
 * every other client behind the CDN.
 */
export function cacheControlNoStore(): string {
  return "no-store, no-cache, must-revalidate, private";
}
