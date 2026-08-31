export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window. */
  requests: number;
  /** Window duration in seconds. */
  window: number;
}

/**
 * Per-route rate-limit table.  Keys are `"METHOD /path"` patterns.  The
 * special key `"default"` applies when no specific pattern matches.
 *
 * Values mirror the table in `docs/ORACLE_AND_BACKEND.md §Rate Limiting`.
 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "GET /api/markets": { requests: 60, window: 60 },
  "GET /api/markets/:id": { requests: 120, window: 60 },
  "POST /api/oracle/*": { requests: 10, window: 60 },
  "POST /api/v1/oracle/submit": { requests: 10, window: 60 },
  default: { requests: 30, window: 60 },
};
