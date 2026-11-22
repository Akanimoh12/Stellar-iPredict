import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  cacheControlNoStore,
  cacheControlPrivate,
  cacheControlPublic,
  getRouteCacheControl,
  registerCacheControlHook,
  ROUTE_CACHE_POLICIES,
} from "./cacheControl.js";
import { CACHE_TTLS } from "./cacheKeys.js";

describe("cacheControl header builders", () => {
  it("builds public Cache-Control header matching TTL and stale-while-revalidate", () => {
    const header = cacheControlPublic(30);
    expect(header).toBe("public, max-age=30, stale-while-revalidate=30");
  });

  it("builds private Cache-Control header for user-specific data", () => {
    const header = cacheControlPrivate(15);
    expect(header).toBe("private, max-age=15");
  });

  it("builds no-store Cache-Control header for uncacheable responses", () => {
    const header = cacheControlNoStore();
    expect(header).toBe("no-store, no-cache, must-revalidate, private");
  });
});

describe("getRouteCacheControl per-route policies", () => {
  it("applies no-store to health and monitoring probes", () => {
    expect(getRouteCacheControl("/healthz")).toBe("no-store, no-cache, must-revalidate, private");
    expect(getRouteCacheControl("/readyz")).toBe("no-store, no-cache, must-revalidate, private");
    expect(getRouteCacheControl("/livez")).toBe("no-store, no-cache, must-revalidate, private");
  });

  it("applies public caching matching CACHE_TTLS to public platform stats", () => {
    const header = getRouteCacheControl("/api/stats");
    expect(header).toBe(`public, max-age=${CACHE_TTLS.statsGlobal}, stale-while-revalidate=${CACHE_TTLS.statsGlobal}`);
  });

  it("applies public caching matching CACHE_TTLS to leaderboard", () => {
    const header = getRouteCacheControl("/api/leaderboard");
    expect(header).toBe(`public, max-age=${CACHE_TTLS.leaderboardTop20}, stale-while-revalidate=${CACHE_TTLS.leaderboardTop20}`);
  });

  it("applies public caching to markets list and handles query parameters", () => {
    const headerWithQuery = getRouteCacheControl("/api/markets?page=1&limit=10&status=active");
    expect(headerWithQuery).toBe(`public, max-age=${CACHE_TTLS.marketsAll}, stale-while-revalidate=${CACHE_TTLS.marketsAll}`);
  });

  it("applies public caching to market detail, odds, and bets", () => {
    expect(getRouteCacheControl("/api/markets/42")).toBe(
      `public, max-age=${CACHE_TTLS.market}, stale-while-revalidate=${CACHE_TTLS.market}`
    );
    expect(getRouteCacheControl("/api/markets/42/odds")).toBe(
      `public, max-age=${CACHE_TTLS.odds}, stale-while-revalidate=${CACHE_TTLS.odds}`
    );
    expect(getRouteCacheControl("/api/markets/42/bets")).toBe(
      `public, max-age=${CACHE_TTLS.bets}, stale-while-revalidate=${CACHE_TTLS.bets}`
    );
  });

  it("applies public caching to operational feeds (resolution status and unmappable)", () => {
    expect(getRouteCacheControl("/resolution-status")).toBe("public, max-age=30, stale-while-revalidate=30");
    expect(getRouteCacheControl("/api/markets/resolution-status")).toBe("public, max-age=30, stale-while-revalidate=30");
    expect(getRouteCacheControl("/api/markets/unmappable")).toBe("public, max-age=60, stale-while-revalidate=60");
  });

  it("applies no-store to user-specific profile routes", () => {
    expect(getRouteCacheControl("/api/v1/profile/GBEXAMPLE")).toBe("no-store, no-cache, must-revalidate, private");
    expect(getRouteCacheControl("/api/v1/profile/GBEXAMPLE/bets")).toBe("no-store, no-cache, must-revalidate, private");
  });

  it("applies no-cache, no-transform to live real-time feeds", () => {
    expect(getRouteCacheControl("/api/markets/live")).toBe("no-cache, no-transform");
    expect(getRouteCacheControl("/api/markets/10/live")).toBe("no-cache, no-transform");
  });

  it("forces no-store on all mutating HTTP methods (POST, PUT, DELETE, PATCH)", () => {
    expect(getRouteCacheControl("/api/markets", "POST")).toBe("no-store, no-cache, must-revalidate, private");
    expect(getRouteCacheControl("/api/oracle/submit", "POST")).toBe("no-store, no-cache, must-revalidate, private");
    expect(getRouteCacheControl("/api/markets/1", "DELETE")).toBe("no-store, no-cache, must-revalidate, private");
  });

  it("defaults to no-store for unknown routes", () => {
    expect(getRouteCacheControl("/unknown/path")).toBe("no-store, no-cache, must-revalidate, private");
  });
});

describe("registerCacheControlHook", () => {
  it("automatically applies route cache policy when handler did not specify one", async () => {
    const server = Fastify({ logger: false });
    registerCacheControlHook(server);

    server.get("/api/stats", async () => ({ totalMarkets: 10 }));
    server.post("/api/markets", async () => ({ created: true }));

    await server.ready();

    const getRes = await server.inject({ method: "GET", url: "/api/stats" });
    expect(getRes.headers["cache-control"]).toBe(
      `public, max-age=${CACHE_TTLS.statsGlobal}, stale-while-revalidate=${CACHE_TTLS.statsGlobal}`
    );

    const postRes = await server.inject({ method: "POST", url: "/api/markets" });
    expect(postRes.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate, private");

    await server.close();
  });

  it("preserves explicitly defined Cache-Control header if already set", async () => {
    const server = Fastify({ logger: false });
    registerCacheControlHook(server);

    server.get("/api/custom", async (_req, reply) => {
      reply.header("Cache-Control", "public, max-age=999");
      return { ok: true };
    });

    await server.ready();

    const res = await server.inject({ method: "GET", url: "/api/custom" });
    expect(res.headers["cache-control"]).toBe("public, max-age=999");

    await server.close();
  });
});
