export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window. */
  requests: number;
  /** Window duration in seconds. */
  window: number;
}

/**
  * Per-route rate-limit table — the anonymous baseline.  Keys are `"METHOD /path"` patterns.  The
 * special key `"default"` applies when no specific pattern matches.
 *
  * Values mirror the table in `docs/ORACLE_AND_BACKEND.md §Rate Limiting`.
 *
 * ## Authenticated vs. anonymous tiers (#485)
 *
 * This is the conservative baseline for requests with no verified identity.
 * See RATE_LIMITS_AUTHENTICATED for higher budgets keyed per identity.
 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "GET /api/markets": { requests: 60, window: 60 },
  "GET /api/markets/:id": { requests: 120, window: 60 },
  "POST /api/oracle/*": { requests: 10, window: 60 },
  "POST /api/v1/oracle/submit": { requests: 10, window: 60 },
  default: { requests: 30, window: 60 },
};
/**
 * Rate limits for **authenticated** requests, keyed per identity.
 *
 * A higher budget than the anonymous tier: an authenticated caller has a
 * verified identity, so sharing an IP (NAT, corporate proxy) should not
 * throttle co-located users.
 *
 * Routes absent from this table fall back to {@link RATE_LIMITS}.
 */
export const RATE_LIMITS_AUTHENTICATED: Record<string, RateLimitConfig> = {
  "GET /api/markets": { requests: 120, window: 60 },
  "GET /api/markets/:id": { requests: 300, window: 60 },
  "GET /api/markets/:id/bets": { requests: 120, window: 60 },
  "GET /api/markets/:id/odds": { requests: 120, window: 60 },
  default: { requests: 60, window: 60 },
};

/**
 * Rate limits for **anonymous** requests, keyed per client address.
 *
 * Conservative budget to protect against scrapers, bots, and unauthenticated
 * abuse.  Authenticated callers are not counted against this bucket.
 */
export const RATE_LIMITS_ANONYMOUS: Record<string, RateLimitConfig> = {
  ...RATE_LIMITS,
};
