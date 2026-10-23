import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HealthCheckResult } from "@/db/health";

vi.mock("@/db/health", async () => {
  const actual = await vi.importActual<typeof import("@/db/health")>("@/db/health");
  return {
    ...actual,
    pingDb: vi.fn(),
    checkWriteCapability: vi.fn(),
  };
});

vi.mock("@/db/redis", () => ({
  pingRedis: vi.fn(),
}));

import { pingDb, checkWriteCapability } from "@/db/health";
import { pingRedis } from "@/db/redis";
import { buildServer } from "@/server";
import { markShuttingDown, resetShuttingDownForTests } from "./health.js";
import { createFakePool } from "../test/fakePool.js";

const pingDbMock = vi.mocked(pingDb);
const checkWriteCapabilityMock = vi.mocked(checkWriteCapability);
const pingRedisMock = vi.mocked(pingRedis);

let server: FastifyInstance | undefined;

function makeServer(): FastifyInstance {
  server = buildServer({ corsOrigins: [], pool: createFakePool() });
  return server;
}

beforeEach(() => {
  pingDbMock.mockReset();
  checkWriteCapabilityMock.mockReset();
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
    checkWriteCapabilityMock.mockResolvedValue({ ok: true, latencyMs: 2, readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");
    expect(body.checks.db).toEqual({ ok: true, latencyMs: 2, readOnly: false });
    expect(body.checks.redis).toEqual({ ok: true, latencyMs: 1 });
  });

  it("returns 503 with status 'not ready' when DB is unhealthy", async () => {
    pingDbMock.mockResolvedValue({ ok: false, error: "connection refused" });
    checkWriteCapabilityMock.mockResolvedValue({ ok: false, error: "connection refused", readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.db.ok).toBe(false);
    expect(body.checks.redis).toEqual({ ok: true, latencyMs: 1 });
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("marks a readable but read-only database as not ready", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 2 });
    checkWriteCapabilityMock.mockResolvedValue({
      ok: false,
      latencyMs: 1,
      error: "cannot execute UPDATE in a read-only transaction",
      readOnly: true,
    });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "not ready",
      checks: { db: { ok: false, readOnly: true } },
    });
    expect(res.body).not.toContain("read-only transaction");
  });

  it("returns 503 with status 'not ready' when Redis is unhealthy", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 3 });
    checkWriteCapabilityMock.mockResolvedValue({ ok: true, latencyMs: 3, readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.db).toEqual({ ok: true, latencyMs: 3, readOnly: false });
    expect(body.checks.redis).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("returns 503 when both DB and Redis are unhealthy", async () => {
    pingDbMock.mockResolvedValue({ ok: false, error: "timeout" });
    checkWriteCapabilityMock.mockResolvedValue({ ok: false, error: "timeout", readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: false, error: "no connection" });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not ready");
    expect(body.checks.db.ok).toBe(false);
    expect(body.checks.redis.ok).toBe(false);
  });

  it("keeps /healthz liveness at 200 while /readyz reports not ready", async () => {
    pingDbMock.mockResolvedValue({ ok: false, error: "timeout" });
    checkWriteCapabilityMock.mockResolvedValue({ ok: false, error: "timeout", readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: false, error: "no connection" });

    const app = makeServer();
    const live = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  });

  it("bounds a hung dependency check with a timeout instead of hanging", async () => {
    pingDbMock.mockImplementation(() => new Promise(() => {})); // never resolves
    checkWriteCapabilityMock.mockImplementation(() => new Promise(() => {})); // never resolves
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toEqual({ ok: false, readOnly: false });
  }, 5000);

  it("fails readiness immediately once shutdown has started", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 1 });
    checkWriteCapabilityMock.mockResolvedValue({ ok: true, latencyMs: 1, readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    markShuttingDown();

    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("not ready");
  });

  it("is kept out of the published OpenAPI spec as an internal probe (#603)", async () => {
    pingDbMock.mockResolvedValue({ ok: true, latencyMs: 1 });
    checkWriteCapabilityMock.mockResolvedValue({ ok: true, latencyMs: 1, readOnly: false });
    pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });

    const app = makeServer();
    await app.ready();

    const spec = app.swagger();
    expect(spec.paths?.["/readyz"]).toBeUndefined();
  });
});
