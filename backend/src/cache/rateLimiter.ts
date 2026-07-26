/**
 * Per-route rate limiting using an in-memory sliding window.
 *
 * Rate limits are defined per route pattern and enforced as a Fastify
 * `onRequest` hook.  When a client exceeds the configured request budget for
 * a window, the hook short-circuits with `429 Too Many Requests` and sets a
 * `Retry-After` header indicating when the window resets.
 *
 * The store is intentionally in-memory (no Redis dependency) to match the
 * backend's current runtime requirements.  It is interface-compatible with a
 * Redis sliding-window approach documented in ORACLE_AND_BACKEND.md §Rate
 * Limiting and can be swapped transparently.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Rate Limiting
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ---------------------------------------------------------------------------
// Shared store interface
// ---------------------------------------------------------------------------

/**
 * Common contract for rate-limit stores — in-memory, Redis, or otherwise.
 *
 * Both {@link SlidingWindowStore} and {@link RedisSlidingWindowStore}
 * implement this interface so they can be passed transparently to
 * {@link registerRateLimiter}.
 */
export interface RateLimitStore {
  increment(
    key: string,
    limit: number,
    windowSec: number
  ): RateLimitResult | Promise<RateLimitResult>;
  destroy?(): void | Promise<void>;
}

/** Return shape shared by all rate-limit stores. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

import { RATE_LIMITS, type RateLimitConfig } from "../config/rateLimits.js";
export { RATE_LIMITS, type RateLimitConfig };

// ---------------------------------------------------------------------------
// Sliding window store
// ---------------------------------------------------------------------------

interface WindowEntry {
  /** Timestamps (ms) of requests within the current window. */
  timestamps: number[];
}

/**
 * In-memory sliding-window request counter, keyed by a composite of
 * client identifier and route pattern.
 *
 * Expired timestamps are lazily pruned on each {@link increment} call,
 * and a periodic sweep removes stale keys to bound memory.
 */
export class SlidingWindowStore implements RateLimitStore {
  private readonly store = new Map<string, WindowEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startSweep();
  }

  /**
   * Record a request and return whether the limit has been exceeded.
   *
   * @returns An object with:
   *   - `allowed`: `true` if the request is within budget.
   *   - `remaining`: how many requests are left in the window.
   *   - `resetMs`: ms until the oldest timestamp in the window expires.
   */
  increment(
    key: string,
    limit: number,
    windowSec: number
  ): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const windowMs = windowSec * 1_000;
    const cutoff = now - windowMs;

    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    // Prune timestamps outside the current window.
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= limit) {
      const oldest = entry.timestamps[0]!;
      const resetMs = oldest + windowMs - now;
      return { allowed: false, remaining: 0, resetMs: Math.max(resetMs, 0) };
    }

    entry.timestamps.push(now);
    const remaining = limit - entry.timestamps.length;
    const oldest = entry.timestamps[0]!;
    const resetMs = oldest + windowMs - now;

    return { allowed: true, remaining, resetMs: Math.max(resetMs, 0) };
  }

  /** Number of tracked keys (clients × routes). */
  get size(): number {
    return this.store.size;
  }

  /** Stop the background sweep. Safe to call multiple times. */
  destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      // If every timestamp is older than the longest possible window,
      // the key is stale and can be removed.
      if (entry.timestamps.length === 0) {
        this.store.delete(key);
        continue;
      }
      const newest = entry.timestamps[entry.timestamps.length - 1]!;
      // Conservative: use a generous 5-minute horizon.
      if (now - newest > 5 * 60 * 1_000) {
        this.store.delete(key);
      }
    }
  }

  private startSweep(): void {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/**
 * Find the rate-limit config for a request.
 *
 * Matching rules (evaluated in order):
 * 1. Exact match on `"METHOD /url"` (after stripping query string).
 * 2. Parameterised match — the last path segment is replaced with `:id`.
 * 3. Wildcard match — the path is truncated and suffixed with `/*`.
 * 4. Falls back to `RATE_LIMITS.default`.
 */
export function resolveRateLimit(
  method: string,
  url: string,
  limits: Record<string, RateLimitConfig> = RATE_LIMITS
): RateLimitConfig {
  const path = url.split("?")[0]!;
  const key = `${method} ${path}`;

  // 1. Exact match.
  if (limits[key]) return limits[key]!;

  // 2. Parameterised: replace last segment with :id.
  const segments = path.split("/");
  if (segments.length > 1) {
    segments[segments.length - 1] = ":id";
    const paramKey = `${method} ${segments.join("/")}`;
    if (limits[paramKey]) return limits[paramKey]!;
  }

  // 3. Wildcard: try progressively shorter prefixes + /*.
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join("/");
    const wildcardKey = `${method} ${prefix}/*`;
    if (limits[wildcardKey]) return limits[wildcardKey]!;
  }

  // 4. Default.
  return limits.default ?? { requests: 30, window: 60 };
}

// ---------------------------------------------------------------------------
// Client identifier
// ---------------------------------------------------------------------------

/**
 * Extract a per-client identifier from a request.  Uses the leftmost IP
 * in `X-Forwarded-For` when behind a reverse proxy, otherwise `req.ip`.
 */
function clientId(req: FastifyRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip;
}

// ---------------------------------------------------------------------------
// Fastify hook
// ---------------------------------------------------------------------------

/** Shared store instance. */
const store = new SlidingWindowStore();

/**
 * Register the per-route rate limiter as a Fastify `onRequest` hook.
 *
 * Call once during server construction (see `buildServer` in server.ts).
 */
export function registerRateLimiter(
  server: FastifyInstance,
  limits: Record<string, RateLimitConfig> = RATE_LIMITS,
  /** @internal override for tests */
  overrideStore?: RateLimitStore
): void {
  const s: RateLimitStore = overrideStore ?? store;

  server.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const config = resolveRateLimit(request.method, request.url, limits);
      const id = clientId(request);
      const key = `${id}:${request.method}:${request.url.split("?")[0]}`;

      // `await` works with both sync (in-memory) and async (Redis) stores.
      const result = await s.increment(key, config.requests, config.window);

      // Always set informational headers.
      reply.header("X-RateLimit-Limit", config.requests);
      reply.header("X-RateLimit-Remaining", result.remaining);
      reply.header(
        "X-RateLimit-Reset",
        Math.ceil((Date.now() + result.resetMs) / 1_000)
      );

      if (!result.allowed) {
        const retryAfter = Math.ceil(result.resetMs / 1_000);
        reply.header("Retry-After", retryAfter);
        reply.status(429).send({
          error: "Too Many Requests",
          message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
          retryAfter,
        });
      }
    }
  );
}
