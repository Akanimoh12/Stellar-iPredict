import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  SlidingWindowStore,
  resolveRateLimit,
  registerRateLimiter,
  RATE_LIMITS,
  type RateLimitConfig,
} from "../cache/rateLimiter.js";
import { RedisSlidingWindowStore } from "../cache/rateLimiterRedis.js";

// ---------------------------------------------------------------------------
// Helpers — mock Redis with in-memory sorted-set semantics
// ---------------------------------------------------------------------------

/**
 * Minimal mock of the ioredis `Redis` surface used by
 * {@link RedisSlidingWindowStore}.  Sorted-set operations are backed by an
 * in-memory `Map` so the Lua script can be simulated in pure JavaScript.
 */
function createMockRedis() {
  // key → Map<member, score>
  const store = new Map<string, Map<string, number>>();

  const mock = {
    eval: vi.fn<
      (
        script: string,
        numKeys: number,
        key: string,
        now: number,
        windowMs: number,
        limit: number,
        member: string
      ) => Promise<[number, number, number]>
    >(),
    quit: vi.fn<() => Promise<void>>(),
  };

  // Simulate EVAL by running the Lua logic in JavaScript.
  mock.eval.mockImplementation(
    async (
      _sha: string,
      _numKeys: number,
      key: string,
      now: number,
      windowMs: number,
      limit: number,
      member: string
    ): Promise<[number, number, number]> => {
      let set = store.get(key);
      if (!set) {
        set = new Map();
        store.set(key, set);
      }

      // ZREMRANGEBYSCORE key -inf cutoff
      const cutoff = now - windowMs;
      for (const [m, score] of set) {
        if (score <= cutoff) set.delete(m);
      }

      // ZCARD key
      const count = set.size;

      if (count >= limit) {
        // ZRANGE key 0 0 WITHSCORES
        let oldestScore = Infinity;
        for (const [, score] of set) {
          if (score < oldestScore) oldestScore = score;
        }
        const resetMs = Math.max(0, oldestScore + windowMs - now);
        return [0, 0, resetMs];
      }

      // ZADD key now member
      set.set(member, now);

      const newRemaining = limit - count - 1;

      // ZRANGE key 0 0 WITHSCORES
      let oldestScore = Infinity;
      for (const [, score] of set) {
        if (score < oldestScore) oldestScore = score;
      }
      if (oldestScore === Infinity) oldestScore = now;
      const resetMs = Math.max(0, oldestScore + windowMs - now);

      return [1, newRemaining, resetMs];
    }
  );

  mock.quit.mockResolvedValue(undefined);

  return mock;
}

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

// ---------------------------------------------------------------------------
// RedisSlidingWindowStore
// ---------------------------------------------------------------------------

describe("RedisSlidingWindowStore", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let store: RedisSlidingWindowStore;

  beforeEach(() => {
    mockRedis = createMockRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new RedisSlidingWindowStore(mockRedis as any);
  });

  it("sends the Lua script via eval on every request", async () => {
    await store.increment("key", 10, 60);
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);

    // Each call sends the full script via EVAL.
    await store.increment("key", 10, 60);
    expect(mockRedis.eval).toHaveBeenCalledTimes(2);
  });

  it("allows requests within the limit", async () => {
    const r = await store.increment("client:route", 3, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("blocks when the limit is exceeded", async () => {
    await store.increment("k", 2, 60);
    await store.increment("k", 2, 60);
    const r = await store.increment("k", 2, 60);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("provides a positive resetMs when blocked", async () => {
    await store.increment("k", 1, 60);
    const r = await store.increment("k", 1, 60);
    expect(r.allowed).toBe(false);
    expect(r.resetMs).toBeGreaterThan(0);
    expect(r.resetMs).toBeLessThanOrEqual(60_000);
  });

  it("allows requests after the window expires", async () => {
    // Simulate time by manipulating the mock's store directly.
    vi.useFakeTimers();
    const now = Date.now();

    // First request at now.
    await store.increment("k", 1, 10);
    // Second request blocked (limit=1).
    const blocked = await store.increment("k", 1, 10);
    expect(blocked.allowed).toBe(false);

    // Advance time past the window.  The Lua script's cutoff is `now - windowMs`,
    // so we need to advance the clock AND evict stale entries.
    // Since the mock runs the Lua logic in JS, fake timers work directly.
    vi.advanceTimersByTime(10_001);

    const allowed = await store.increment("k", 1, 10);
    expect(allowed.allowed).toBe(true);

    vi.useRealTimers();
  });

  it("tracks separate keys independently", async () => {
    await store.increment("a", 1, 60);
    const r = await store.increment("b", 1, 60);
    expect(r.allowed).toBe(true);
  });

  it("passes the correct arguments to eval", async () => {
    vi.useFakeTimers();
    const now = Date.now();

    await store.increment("mykey", 5, 30);

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const args = mockRedis.eval.mock.calls[0];
    // args: script, numKeys, redisKey, now, windowMs, limit, member
    expect(typeof args[0]).toBe("string"); // the Lua script
    expect(args[1]).toBe(1); // numKeys
    expect(args[2]).toContain("ratelimit:mykey");
    expect(args[3]).toBe(now);
    expect(args[4]).toBe(30_000); // 30 s → ms
    expect(args[5]).toBe(5);
    expect(typeof args[6]).toBe("string");
    expect((args[6] as string).length).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it("destroy is a no-op for the shared-Redis store", async () => {
    await store.destroy();
    expect(mockRedis.quit).not.toHaveBeenCalled();
  });

  it("returns consistent remaining counts", async () => {
    const limit = 4;
    for (let i = 0; i < limit; i++) {
      const r = await store.increment("consistent", limit, 60);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(limit - i - 1);
    }
    const blocked = await store.increment("consistent", limit, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});
