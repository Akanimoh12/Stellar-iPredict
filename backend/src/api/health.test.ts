import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HealthCheckResult } from "@/db/health";

vi.mock("@/db/health", () => ({
  pingDb: vi.fn(),
}));

vi.mock("@/db/redis", () => ({
  pingRedis: vi.fn(),
}));

import { pingDb } from "@/db/health";
import { pingRedis } from "@/db/redis";
import { buildServer } from "@/server";
import { markShuttingDown, resetShuttingDownForTests } from "./health.js";

const pingDbMock = vi.mocked(pingDb);
const pingRedisMock = vi.mocked(pingRedis);

let server: FastifyInstance | undefined;

function makeServer(): FastifyInstance {
  server = buildServer({ corsOrigins: [] });
  return server;
}

beforeEach(() => {
  pingDbMock.mockReset();
  pingRedisMock.mockReset();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  resetShuttingDownForTests();
});

describe("GET /readyz", () => {
  it("returns 200 with status 'ready' when both DB and Redis are healthy", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 2 });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");
    expect(body.checks.db).toEqual({ ok: true, latencyMs: 2 });
    expect(body.checks.redis).toEqual({ ok: true, latencyMs: 1 });
  });

  it("returns 503 with status 'not ready' when DB is unhealthy", async () => {
    pingDbMock.mockResolvedValue({ ok: false, error: "connection refused" });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.db).toEqual({ ok: false });
    expect(body.checks.redis).toEqual({ ok: true, latencyMs: 1 });
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("returns 503 with status 'not ready' when Redis is unhealthy", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 3 });
    pingRedisMock.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.db).toEqual({ ok: true, latencyMs: 3 });
    expect(body.checks.redis).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("returns 503 when both DB and Redis are unhealthy", async () => {
    pingDbMock.mockResolvedValue({ ok: false, error: "timeout" });
    pingRedisMock.mockResolvedValue({ ok: false, error: "no connection" });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.db.ok).toBe(false);
    expect(body.checks.redis.ok).toBe(false);
  });

  it("bounds a hung dependency check with a timeout instead of hanging", async () => {
    pingDbMock.mockImplementation(() => new Promise(() => {})); // never resolves
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toEqual({ ok: false });
  }, 5000);

  it("fails readiness immediately once shutdown has started", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 1 });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    markShuttingDown();

    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("not ready");
  });

  it("includes the system tag in OpenAPI schema", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 1 });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    await app.ready();

    const spec = app.swagger();
    const readyzPath = spec.paths?.["/readyz"];
    expect(readyzPath).toBeDefined();
    expect(readyzPath?.get?.tags).toContain("system");
  });
});
