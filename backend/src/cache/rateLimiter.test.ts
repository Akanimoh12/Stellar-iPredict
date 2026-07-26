import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  SlidingWindowStore,
  resolveRateLimit,
  registerRateLimiter,
  RATE_LIMITS,
  type RateLimitConfig,
} from "../cache/rateLimiter.js";

// ---------------------------------------------------------------------------
// SlidingWindowStore
// ---------------------------------------------------------------------------

describe("SlidingWindowStore", () => {
  let store: SlidingWindowStore;

  beforeEach(() => {
    store = new SlidingWindowStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it("allows requests within the limit", () => {
    const r = store.increment("client:route", 3, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("blocks when the limit is exceeded", () => {
    store.increment("k", 2, 60);
    store.increment("k", 2, 60);
    const r = store.increment("k", 2, 60);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("provides a positive resetMs when blocked", () => {
    store.increment("k", 1, 60);
    const r = store.increment("k", 1, 60);
    expect(r.allowed).toBe(false);
    expect(r.resetMs).toBeGreaterThan(0);
    expect(r.resetMs).toBeLessThanOrEqual(60_000);
  });

  it("allows requests after the window expires", () => {
    vi.useFakeTimers();

    store.increment("k", 1, 10);
    expect(store.increment("k", 1, 10).allowed).toBe(false);

    vi.advanceTimersByTime(10_001);
    expect(store.increment("k", 1, 10).allowed).toBe(true);

    vi.useRealTimers();
  });

  it("tracks separate keys independently", () => {
    store.increment("a", 1, 60);
    const r = store.increment("b", 1, 60);
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRateLimit
// ---------------------------------------------------------------------------

describe("resolveRateLimit", () => {
  it("matches an exact route", () => {
    const config = resolveRateLimit("GET", "/api/markets");
    expect(config).toEqual(RATE_LIMITS["GET /api/markets"]);
  });

  it("matches a parameterised route", () => {
    const config = resolveRateLimit("GET", "/api/markets/42");
    expect(config).toEqual(RATE_LIMITS["GET /api/markets/:id"]);
  });

  it("matches a wildcard route", () => {
    const config = resolveRateLimit("POST", "/api/oracle/submit");
    expect(config).toEqual(RATE_LIMITS["POST /api/oracle/*"]);
  });

  it("strips query strings before matching", () => {
    const config = resolveRateLimit("GET", "/api/markets?page=2");
    expect(config).toEqual(RATE_LIMITS["GET /api/markets"]);
  });

  it("falls back to the default for unknown routes", () => {
    const config = resolveRateLimit("DELETE", "/api/unknown/path");
    expect(config).toEqual(RATE_LIMITS.default);
  });

  it("uses a custom limits map when provided", () => {
    const custom: Record<string, RateLimitConfig> = {
      "GET /custom": { requests: 5, window: 10 },
      default: { requests: 1, window: 1 },
    };
    expect(resolveRateLimit("GET", "/custom", custom)).toEqual({
      requests: 5,
      window: 10,
    });
    expect(resolveRateLimit("GET", "/other", custom)).toEqual({
      requests: 1,
      window: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Fastify integration
// ---------------------------------------------------------------------------

describe("registerRateLimiter (Fastify hook)", () => {
  let server: FastifyInstance;
  let store: SlidingWindowStore;

  const LIMITS: Record<string, RateLimitConfig> = {
    "GET /test": { requests: 3, window: 60 },
    default: { requests: 2, window: 60 },
  };

  beforeEach(() => {
    store = new SlidingWindowStore();
    server = Fastify({ logger: false });
    registerRateLimiter(server, LIMITS, store);

    server.get("/test", async () => ({ ok: true }));
    server.get("/other", async () => ({ ok: true }));
  });

  afterEach(async () => {
    store.destroy();
    await server.close();
  });

  it("allows requests within the limit", async () => {
    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBe("2");
  });

  it("returns 429 when the limit is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      await server.inject({ method: "GET", url: "/test" });
    }

    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(429);

    const body = res.json();
    expect(body.error).toBe("Too Many Requests");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("sets Retry-After header on 429", async () => {
    for (let i = 0; i < 3; i++) {
      await server.inject({ method: "GET", url: "/test" });
    }

    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("applies the default limit to unmatched routes", async () => {
    // Default is 2 req/60s.
    await server.inject({ method: "GET", url: "/other" });
    await server.inject({ method: "GET", url: "/other" });
    const res = await server.inject({ method: "GET", url: "/other" });
    expect(res.statusCode).toBe(429);
  });

  it("tracks different routes independently", async () => {
    // Use up /test's 3-request limit.
    for (let i = 0; i < 3; i++) {
      await server.inject({ method: "GET", url: "/test" });
    }

    // /other should still have its own budget.
    const res = await server.inject({ method: "GET", url: "/other" });
    expect(res.statusCode).toBe(200);
  });

  it("sets X-RateLimit-Reset header", async () => {
    const res = await server.inject({ method: "GET", url: "/test" });
    const reset = Number(res.headers["x-ratelimit-reset"]);
    expect(reset).toBeGreaterThan(0);
    // Should be within roughly 60 seconds from now.
    const nowSec = Math.ceil(Date.now() / 1_000);
    expect(reset).toBeGreaterThanOrEqual(nowSec);
    expect(reset).toBeLessThanOrEqual(nowSec + 61);
  });
});
