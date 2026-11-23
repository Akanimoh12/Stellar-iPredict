/**
 * Chaos tests: dependencies are killed and restored while the same API
 * instance keeps serving requests (issue #996).
 *
 * resilience.test.ts covers outages that exist from the first request. This
 * suite flips a dependency off between requests, so one server must degrade,
 * keep serving whatever it still can, and recover when the dependency returns.
 *
 * The outage is injected in-process (no sockets are opened), so the suite runs
 * on any machine and in CI without stopping real Postgres or Redis containers.
 *
 * Scope: only `/api/stats` and `/healthz` are exercised. `/readyz` and `/status`
 * call the module-level Redis client (`pingRedis`), which would open a real
 * connection, so they are deliberately left to resilience.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";

import { createTestRedis } from "../test/fakeRedis.js";
import { buildServer } from "../server.js";

interface Dependencies {
  dbDown: boolean;
  redisDown: boolean;
}

const REDIS_COMMANDS = ["get", "set", "setex", "del", "ping"] as const;

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

/**
 * Builds a server whose PostgreSQL pool and Redis client can be killed and
 * restored through `deps`. Killing Redis makes every command reject, as ioredis
 * does once its socket is gone.
 */
function buildChaosServer(deps: Dependencies) {
  const pool = {
    query: vi.fn(async () => {
      if (deps.dbDown) throw new Error("ECONNREFUSED");
      return statsRow();
    }),
  };

  const redis = createTestRedis();
  const target = redis as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of REDIS_COMMANDS) {
    const real = target[name].bind(redis);
    target[name] = (...args: unknown[]) =>
      deps.redisDown ? Promise.reject(new Error("Connection is closed.")) : real(...args);
  }

  const server = buildServer({
    corsOrigins: [],
    logger: false,
    pool: pool as never,
    redis: redis as unknown as Redis,
  });

  return { server, pool };
}

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("chaos: Redis killed mid-run", () => {
  it("keeps serving from the database and recovers when Redis returns", async () => {
    const deps: Dependencies = { dbDown: false, redisDown: false };
    const built = buildChaosServer(deps);
    server = built.server;

    // Healthy: first request populates the cache.
    const warm = await server.inject({ method: "GET", url: "/api/stats" });
    expect(warm.statusCode).toBe(200);
    expect(built.pool.query).toHaveBeenCalledTimes(1);

    // Kill Redis: cache reads reject, so the handler must fall back to the DB.
    deps.redisDown = true;
    const degraded = await server.inject({ method: "GET", url: "/api/stats" });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toBeTruthy();
    expect(built.pool.query).toHaveBeenCalledTimes(2);

    // Restore Redis: the very next request is served normally again.
    deps.redisDown = false;
    const recovered = await server.inject({ method: "GET", url: "/api/stats" });
    expect(recovered.statusCode).toBe(200);
  });

  it("keeps liveness at 200 while Redis is down", async () => {
    const deps: Dependencies = { dbDown: false, redisDown: true };
    server = buildChaosServer(deps).server;

    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("chaos: PostgreSQL killed mid-run", () => {
  it("serves a warm cache entry while the DB is down, without touching the DB", async () => {
    const deps: Dependencies = { dbDown: false, redisDown: false };
    const built = buildChaosServer(deps);
    server = built.server;

    const warm = await server.inject({ method: "GET", url: "/api/stats" });
    expect(warm.statusCode).toBe(200);

    deps.dbDown = true;
    const callsBefore = built.pool.query.mock.calls.length;

    const cached = await server.inject({ method: "GET", url: "/api/stats" });
    expect(cached.statusCode).toBe(200);
    expect(built.pool.query.mock.calls.length).toBe(callsBefore);
  });

  it("returns the 500 error envelope on a cache miss, then recovers when the DB returns", async () => {
    const deps: Dependencies = { dbDown: true, redisDown: false };
    server = buildChaosServer(deps).server;

    const failed = await server.inject({ method: "GET", url: "/api/stats" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: { code: "INTERNAL_SERVER_ERROR" } });

    deps.dbDown = false;
    const recovered = await server.inject({ method: "GET", url: "/api/stats" });
    expect(recovered.statusCode).toBe(200);
  });

  it("keeps the process alive through repeated outages", async () => {
    const deps: Dependencies = { dbDown: false, redisDown: false };
    server = buildChaosServer(deps).server;

    for (let round = 0; round < 3; round++) {
      deps.dbDown = true;
      const down = await server.inject({ method: "GET", url: "/api/stats" });
      expect([200, 500]).toContain(down.statusCode);

      deps.dbDown = false;
      const up = await server.inject({ method: "GET", url: "/api/stats" });
      expect(up.statusCode).toBe(200);
    }

    const health = await server.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  });
});

describe("chaos: both dependencies killed", () => {
  it("fails the data route with the error envelope while liveness stays up", async () => {
    const deps: Dependencies = { dbDown: true, redisDown: true };
    server = buildChaosServer(deps).server;

    const data = await server.inject({ method: "GET", url: "/api/stats" });
    expect(data.statusCode).toBe(500);
    expect(data.json()).toMatchObject({ error: { code: "INTERNAL_SERVER_ERROR" } });

    const health = await server.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  });
});
