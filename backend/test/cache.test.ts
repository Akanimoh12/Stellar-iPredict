import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { getOrSet, withSingleFlight } from "../src/cache/cacheAside.js";
import {
  invalidate,
  invalidateOnBetPlaced,
  invalidateOnMarketCancelled,
  invalidateOnMarketCreated,
  invalidateOnMarketResolved,
} from "../src/cache/invalidate.js";
import {
  marketKey,
  marketsActiveKey,
  marketsAllKey,
  leaderboardKey,
  betsKey,
  resetVersion,
} from "../src/cache/cacheKeys.js";
import {
  RATE_LIMITS,
  SlidingWindowStore,
  registerRateLimiter,
  resolveRateLimit,
} from "../src/cache/rateLimiter.js";

function createFakeRedis() {
  const store = new Map<string, string>();

  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK" as const;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) {
          deleted++;
        }
      }
      return deleted;
    }),
  };
}

describe("cache layer", () => {
  it("getOrSet returns cached values, refreshes misses, and deduplicates loaders", async () => {
    const redis = createFakeRedis();
    redis._store.set("market:1", JSON.stringify({ id: 1 }));

    const cached = await getOrSet(redis as never, "market:1", 30, vi.fn(async () => ({ id: 2 })));
    expect(cached).toEqual({ id: 1 });

    const loader = vi.fn(async () => ({ fresh: true }));
    const [first, second] = await Promise.all([
      getOrSet(redis as never, "market:2", 30, loader),
      getOrSet(redis as never, "market:2", 30, loader),
    ]);

    expect(first).toEqual({ fresh: true });
    expect(second).toEqual({ fresh: true });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledWith("market:2", 30, JSON.stringify({ fresh: true }));
  });

  it("withSingleFlight shares one in-flight promise per key", async () => {
    let calls = 0;
    const value = await Promise.all([
      withSingleFlight("hot", "cache", async () => {
        calls++;
        return "ok";
      }),
      withSingleFlight("hot", "cache", async () => {
        calls++;
        return "nope";
      }),
    ]);

    expect(value).toEqual(["ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("invalidates the expected cache keys for each market event", async () => {
    resetVersion();
    const redis = createFakeRedis();
    const marketId = 9;

    for (const key of [marketKey(marketId), marketsAllKey(), marketsActiveKey(), leaderboardKey(), betsKey(marketId)]) {
      redis._store.set(key, "cached");
    }

    await invalidateOnMarketCreated(redis as never);
    expect(redis._store.has(marketsAllKey())).toBe(false);
    expect(redis._store.has(marketsActiveKey())).toBe(false);

    redis._store.set(marketKey(marketId), "cached");
    redis._store.set(marketsActiveKey(), "cached");
    await invalidateOnBetPlaced(redis as never, marketId);
    expect(redis._store.has(marketKey(marketId))).toBe(false);
    expect(redis._store.has(marketsActiveKey())).toBe(false);

    redis._store.set(marketKey(marketId), "cached");
    redis._store.set(marketsAllKey(), "cached");
    redis._store.set(marketsActiveKey(), "cached");
    redis._store.set(leaderboardKey(), "cached");
    redis._store.set(betsKey(marketId), "cached");
    await invalidateOnMarketResolved(redis as never, marketId);
    expect(redis._store.has(marketKey(marketId))).toBe(false);
    expect(redis._store.has(marketsAllKey())).toBe(false);
    expect(redis._store.has(marketsActiveKey())).toBe(false);
    expect(redis._store.has(leaderboardKey())).toBe(false);
    expect(redis._store.has(betsKey(marketId))).toBe(false);

    redis._store.set(marketKey(marketId), "cached");
    redis._store.set(marketsAllKey(), "cached");
    redis._store.set(marketsActiveKey(), "cached");
    await invalidateOnMarketCancelled(redis as never, marketId);
    expect(redis._store.has(marketKey(marketId))).toBe(false);
    expect(redis._store.has(marketsAllKey())).toBe(false);
    expect(redis._store.has(marketsActiveKey())).toBe(false);
  });

  it("delete primitive returns zero when no keys are supplied", async () => {
    const redis = createFakeRedis();
    await expect(invalidate(redis as never)).resolves.toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("resolves route limits and enforces the limiter hook", async () => {
    expect(resolveRateLimit("GET", "/api/markets")).toEqual(RATE_LIMITS["GET /api/markets"]);
    expect(resolveRateLimit("GET", "/api/markets/42")).toEqual(RATE_LIMITS["GET /api/markets/:id"]);
    expect(resolveRateLimit("POST", "/api/oracle/submit")).toEqual(RATE_LIMITS["POST /api/oracle/*"]);

    const store = new SlidingWindowStore();
    const app = Fastify({ logger: false });
    registerRateLimiter(
      app,
      {
        "GET /limited": { requests: 2, window: 60 },
        default: { requests: 100, window: 60 },
      },
      store,
    );

    app.get("/limited", async () => ({ ok: true }));
    await app.ready();

    const first = await app.inject({ method: "GET", url: "/limited" });
    const second = await app.inject({ method: "GET", url: "/limited" });
    const third = await app.inject({ method: "GET", url: "/limited" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);

    await app.close();
    store.destroy();
  });
});
