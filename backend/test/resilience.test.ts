/**
 * Error-path tests: how the backend behaves when PostgreSQL or Redis is down
 * (issue #240).
 *
 * Everything here runs against mocks and the FakeRedis bootstrap — no real
 * services, so the suite is deterministic on any machine. It pins the failure
 * contracts the app must uphold when a dependency is unavailable:
 *
 *   - `pingDb` / `pingRedis` report `ok: false` with a reason, never throw
 *   - `/readyz` degrades to 503 while `/healthz` stays 200 (liveness)
 *   - cache errors follow their documented contract: read failures propagate,
 *     write failures are swallowed so the request still returns real data
 *   - route handlers surface dependency failures as the standard 500 envelope
 *     instead of crashing the process
 */

import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";

import { getOrSet } from "../src/cache/cacheAside.js";
import { statsKey } from "../src/cache/cacheKeys.js";
import { createTestRedis } from "../src/test/fakeRedis.js";

// PostgreSQL is unreachable for every suite in this file.
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }),
  },
}));

// Redis is unreachable: every ioredis client the app constructs fails its
// commands. This keeps the real `getRedisClient` / `pingRedis` error-handling
// code under test while guaranteeing no socket is ever opened.
vi.mock("ioredis", async (importOriginal) => {
  const original = await importOriginal<typeof import("ioredis")>();
  return {
    ...original,
    default: class FakeRedis {
      ping(): Promise<never> {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      quit(): Promise<"OK"> {
        return Promise.resolve("OK");
      }
    },
  };
});

import { pingDb } from "../src/db/health.js";
import { pingRedis } from "../src/db/redis.js";
import { buildServer } from "../src/server.js";

function failingPool(): never {
  throw new Error("Database is unreachable");
}

function statsRow() {
  return {
    rows: [
      {
        total_markets: "1",
        total_volume: "150.0000000",
        total_users: "1",
        total_bets: "1",
      },
    ],
  };
}

function okPool() {
  return { query: vi.fn(async () => statsRow()) };
}

describe("health checks when dependencies are down", () => {
  it("pingDb returns ok:false with a reason instead of throwing", async () => {
    const result = await pingDb();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("pingRedis returns ok:false with a reason instead of throwing", async () => {
    const result = await pingRedis();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("/readyz reports 503 not-ready when both DB and Redis are down", async () => {
    const server = buildServer({ corsOrigins: [], logger: false });
    try {
      const res = await server.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe("not ready");
      expect(body.checks.db.ok).toBe(false);
      expect(body.checks.redis.ok).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("/healthz liveness stays 200 even when everything is down", async () => {
    const server = buildServer({ corsOrigins: [], logger: false });
    try {
      const res = await server.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    } finally {
      await server.close();
    }
  });
});

describe("route handlers when the database is down", () => {
  it("/api/stats returns the 500 error envelope, not a crash", async () => {
    const server = buildServer({
      corsOrigins: [],
      logger: false,
      pool: { query: vi.fn(async () => failingPool()) } as never,
      redis: createTestRedis() as unknown as Redis,
    });
    try {
      const res = await server.inject({ method: "GET", url: "/api/stats" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        error: { code: "INTERNAL_SERVER_ERROR" },
      });
    } finally {
      await server.close();
    }
  });

  it("/api/stats still serves real data when the DB query fails but Redis has a hit", async () => {
    // Redis is up and returns a cache hit — the DB is never touched.
    const redis = createTestRedis();
    await redis.setex(statsKey(), 60, JSON.stringify(statsRow()));

    let dbCalled = false;
    const server = buildServer({
      corsOrigins: [],
      logger: false,
      pool: {
        query: vi.fn(async () => {
          dbCalled = true;
          return failingPool();
        }),
      } as never,
      redis: redis as unknown as Redis,
    });
    try {
      const res = await server.inject({ method: "GET", url: "/api/stats" });
      expect(res.statusCode).toBe(200);
      expect(dbCalled).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe("route handlers when Redis is down", () => {
  it("a failing Redis read surfaces the 500 envelope instead of leaking", async () => {
    // Redis.get throws → getOrSet read failure propagates by contract; the
    // route turns it into the standard error envelope, never a crash.
    const redis = createTestRedis();
    redis.get = async () => {
      throw new Error("Connection lost to Redis");
    };

    const server = buildServer({
      corsOrigins: [],
      logger: false,
      pool: { query: okPool().query } as never,
      redis: redis as unknown as Redis,
    });
    try {
      const res = await server.inject({ method: "GET", url: "/api/stats" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        error: { code: "INTERNAL_SERVER_ERROR" },
      });
    } finally {
      await server.close();
    }
  });

  it("a query-succeeding route still 200s when the cache merely fails to write", async () => {
    // The optimistic-cache contract: a failed SETEX is swallowed so the
    // caller receives freshly-loaded data regardless.
    const redis = createTestRedis();
    redis.setex = async () => {
      throw new Error("readonly store");
    };

    const loader = vi.fn(async () => ({ totalMarkets: 3 }));

    const value = await getOrSet(redis as never, "ipredict:v1:stats", 60, loader);
    expect(value).toEqual({ totalMarkets: 3 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("getOrSet propagates a failed cache read", async () => {
    const redis = createTestRedis();
    redis.get = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(
      getOrSet(redis as never, "ipredict:v1:stats", 60, async () => 1)
    ).rejects.toThrow("ECONNREFUSED");
  });
});