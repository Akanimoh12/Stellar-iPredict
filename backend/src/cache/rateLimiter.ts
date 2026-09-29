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
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config/index.js";

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
    windowSec: number,
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

import {
  RATE_LIMITS,
  RATE_LIMITS_AUTHENTICATED,
  RATE_LIMITS_ANONYMOUS,
  type RateLimitConfig,
} from "../config/rateLimits.js";
export {
  RATE_LIMITS,
  RATE_LIMITS_AUTHENTICATED,
  RATE_LIMITS_ANONYMOUS,
  type RateLimitConfig,
};

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
    windowSec: number,
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
  limits: Record<string, RateLimitConfig> = RATE_LIMITS,
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
 * Verify that a candidate credential matches one of the known API keys.
 *
 * Uses `crypto.timingSafeEqual` for constant-time comparison to prevent
 * timing-attack key enumeration (#485).  Empty-string or whitespace-only
 * candidates always return `false` without touching `timingSafeEqual`,
 * since `timingSafeEqual` throws on zero-length buffers.
 *
 * @param candidate The credential extracted from the request.
 * @param knownKeys  The list of valid API keys (from config).
 * @returns `true` if the candidate matches a known key.
 */
function verifyApiKey(candidate: string, knownKeys: readonly string[]): boolean {
  // Guard: empty or whitespace-only credentials can never be valid.
  // Also protects against `timingSafeEqual` throwing on zero-length buffers
  // and avoids unnecessary buffer allocation.
  if (candidate == null || candidate.trim().length === 0) {
    return false;
  }
  if (knownKeys.length === 0) {
    return false;
  }

  const candidateBuf = Buffer.from(candidate, "utf8");
  for (const key of knownKeys) {
    if (Buffer.byteLength(key, "utf8") === candidateBuf.length) {
      const keyBuf = Buffer.from(key, "utf8");
      if (timingSafeEqual(candidateBuf, keyBuf)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Determine whether a request carries a **verified** authenticated identity,
 * and return a stable per-identity identifier when it does.
 *
 * Supported credential sources (checked in order):
 *  1. `Authorization: Bearer <key>`  → `auth:<sha256-of-key>`
 *  2. `Authorization: Api-Key <key>`  → `key:<sha256-of-key>`
 *  3. `X-API-Key: <key>`              → `key:<sha256-of-key>`
 *  4. Oracle body `provider` field    → `provider:<name>`
 *
 * ## Verification (#485)
 *
 * A credential is only honoured when it matches one of the keys listed in
 * `config.API_KEYS` (populated from the `API_KEYS` environment variable).
 * Comparison uses `crypto.timingSafeEqual` to prevent timing-attack key
 * enumeration.  An unverified token — e.g. a random string sent with a
 * `Bearer` scheme — does **not** qualify for the authenticated tier and
 * the caller is treated as anonymous, preserving the higher anonymous limit.
 *
 * Returns `null` when no recognised credential is present **or** when the
 * credential fails verification.
 */
function authenticatedIdentity(req: FastifyRequest): string | null {
  const knownKeys = config.API_KEYS;

  // No configured API keys → nobody can be elevated (fail closed).
  if (knownKeys.length === 0) {
    return null;
  }

  const auth = req.headers.authorization;

  // Helper: extract the raw credential from the Authorization header.
  const extractAuthCredential = (): string | null => {
    if (typeof auth !== "string") return null;
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    if (bearer) return bearer[1];
    const apiKey = auth.match(/^Api-Key\s+(.+)$/i);
    if (apiKey) return apiKey[1];
    return null;
  };

  const verifiedCredential = (() => {
    const cred = extractAuthCredential();
    if (cred !== null && verifyApiKey(cred, knownKeys)) {
      return cred;
    }
    return null;
  })();

  // 1. Verified Authorization: Bearer or Api-Key.
  if (verifiedCredential !== null) {
    // For oracle endpoints, prefer the `provider` body field as the identity
    // so each oracle provider gets its own rate-limit bucket.
    if (req.url.includes("/oracle/submit") && req.body) {
      const body = req.body as Record<string, unknown>;
      const provider = body.provider;
      if (typeof provider === "string" && provider.length > 0) {
        return `provider:${provider}`;
      }
    }
        const prefix = /^Bearer\s+/i.test(auth ?? "") ? "auth" : "key";
    return `${prefix}:${hashToken(verifiedCredential)}`;
  }

  // 2. X-API-Key header.
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.length > 0) {
    if (verifyApiKey(xApiKey, knownKeys)) {
      return `key:${hashToken(xApiKey)}`;
    }
  }

  return null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Client identification
// ---------------------------------------------------------------------------

/**
 * Resolve the per-client identity for rate-limit keying.
 *
 * Prefers an authenticated identity (hashed Bearer token / API key /
 * provider) so that a single user gets one shared bucket across IPs.
  * Falls back to `req.ip` (which respects constrained `trustProxy`) for
 * anonymous requests.
 */
function clientId(req: FastifyRequest): string {
  return authenticatedIdentity(req) ?? req.ip;
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
  overrideStore?: RateLimitStore,
): void {
  const s: RateLimitStore = overrideStore ?? store;

  server.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Determine whether the request carries an authenticated identity.
      // Authenticated callers get the higher per-identity budget from
      // RATE_LIMITS_AUTHENTICATED and are keyed by identity, not IP (#485).
      const identity = authenticatedIdentity(request);
      const isAuthenticated = identity !== null;
      const effectiveLimits = isAuthenticated ? RATE_LIMITS_AUTHENTICATED : limits;
      const config = resolveRateLimit(
        request.method,
        request.url,
        effectiveLimits,
      );
      const id = identity ?? request.ip;
      const key = `${id}:${request.method}:${request.url.split("?")[0]}`;

      // `await` works with both sync (in-memory) and async (Redis) stores.
      const result = await s.increment(key, config.requests, config.window);

      // Always set informational headers.
      reply.header("X-RateLimit-Limit", config.requests);
      reply.header("X-RateLimit-Remaining", result.remaining);
      reply.header(
        "X-RateLimit-Reset",
        Math.ceil((Date.now() + result.resetMs) / 1_000),
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
    },
  );
}
