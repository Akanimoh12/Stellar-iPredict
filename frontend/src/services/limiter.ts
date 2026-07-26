/**
 * ── Rate limiter ─────────────────────────────────────────────────────────────
 *
 * A small, dependency-free fixed-window limiter used to keep a single client
 * (or a single cache key) from stampeding an upstream we pay for — the Soroban
 * RPC proxy in `app/api/rpc/route.ts` being the main one.
 *
 * Why a FIXED window and not a sliding log:
 *  - A sliding log keeps one timestamp per request, so memory grows with
 *    traffic — exactly the wrong shape for the launch-spike case we're
 *    defending against.
 *  - A fixed window keeps ONE counter per key. Worst case it lets through 2x
 *    the limit across a window boundary, which is fine here: the limit exists
 *    to stop abuse and runaway loops, not to meter billing to the request.
 *
 * State is per-process (per edge instance / per browser tab). That is
 * deliberate — there is no shared store to depend on, so the limiter can never
 * be the thing that takes the app down. See the cache's degradation notes in
 * `services/cache.ts` for the same principle applied to storage.
 */

export interface RateLimitResult {
  /** False when the caller has exhausted its budget for the current window. */
  allowed: boolean;
  /** Configured maximum requests per window. */
  limit: number;
  /** Requests still available in this window (0 once blocked). */
  remaining: number;
  /** Epoch ms at which the current window rolls over. */
  resetAt: number;
  /** Milliseconds until the window rolls over — feeds the `Retry-After` header. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Max requests allowed per key per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Soft cap on tracked keys. When exceeded, expired windows are swept before
   * new keys are admitted, so a flood of unique IPs can't grow the map without
   * bound.
   */
  maxKeys?: number;
}

export interface RateLimiter {
  /** Count a request against `key` and report whether it is allowed. */
  check(key: string, now?: number): RateLimitResult;
  /** Report the current budget for `key` WITHOUT counting a request. */
  peek(key: string, now?: number): RateLimitResult;
  /** Forget one key, or every key when called with no argument. */
  reset(key?: string): void;
  /** Number of keys currently tracked (windows may be expired). */
  size(): number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
}: RateLimiterOptions): RateLimiter {
  if (limit <= 0) throw new Error("rate limiter: `limit` must be > 0");
  if (windowMs <= 0) throw new Error("rate limiter: `windowMs` must be > 0");

  const windows = new Map<string, WindowState>();

  /** Drop expired windows. Called only when the map outgrows `maxKeys`. */
  function sweep(now: number): void {
    for (const [key, win] of windows) {
      if (now >= win.resetAt) windows.delete(key);
    }
  }

  function result(win: WindowState, now: number): RateLimitResult {
    const remaining = Math.max(0, limit - win.count);
    return {
      allowed: win.count <= limit,
      limit,
      remaining,
      resetAt: win.resetAt,
      retryAfterMs: Math.max(0, win.resetAt - now),
    };
  }

  return {
    check(key, now = Date.now()) {
      const existing = windows.get(key);

      // No window yet, or the previous one has rolled over → start a fresh one.
      if (!existing || now >= existing.resetAt) {
        if (!existing && windows.size >= maxKeys) sweep(now);
        const win: WindowState = { count: 1, resetAt: now + windowMs };
        windows.set(key, win);
        return result(win, now);
      }

      existing.count += 1;
      return result(existing, now);
    },

    peek(key, now = Date.now()) {
      const existing = windows.get(key);
      if (!existing || now >= existing.resetAt) {
        return {
          allowed: true,
          limit,
          remaining: limit,
          resetAt: now + windowMs,
          retryAfterMs: 0,
        };
      }
      return result(existing, now);
    },

    reset(key) {
      if (key === undefined) windows.clear();
      else windows.delete(key);
    },

    size() {
      return windows.size;
    },
  };
}
