import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("@/db/health", () => ({ pingDb: vi.fn() }));
vi.mock("@/db/redis", () => ({ pingRedis: vi.fn() }));

import { pingDb } from "@/db/health";
import { pingRedis } from "@/db/redis";
import { buildServer } from "@/server";
import { createMaintenanceState } from "@/lib/maintenance";

const pingDbMock = vi.mocked(pingDb);
const pingRedisMock = vi.mocked(pingRedis);

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function healthyPings() {
  pingDbMock.mockResolvedValue({ ok: true, latencyMs: 1 });
  pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });
}

function failingPings() {
  pingDbMock.mockResolvedValue({ ok: false, error: "timeout" });
  pingRedisMock.mockResolvedValue({ ok: false, error: "timeout" });
}

describe("/readyz during maintenance", () => {
  describe("liveness probe (/healthz) is unaffected by maintenance", () => {
    it("returns 200 in full maintenance mode", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("full"),
        set: vi.fn(),
      } as any;

      server = buildServer({ corsOrigins: [], redis: mockRedis });
      healthyPings();
      await server.ready();

      const res = await server.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
    });
  });

  describe("readiness probe reports maintenance distinctly from failure", () => {
    it("returns 200 with status 'ready (maintenance)' in full mode (not 503)", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("full"),
        set: vi.fn(),
      } as any;

      server = buildServer({ corsOrigins: [], redis: mockRedis });
      healthyPings();
      await server.ready();

      const res = await server.inject({ method: "GET", url: "/readyz" });

      // Key assertion: 200 (not 503), status is "ready (maintenance)" not "not ready"
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ready (maintenance)");
      expect(body.maintenance).toEqual({ mode: "full" });
    });

    it("returns 200 with status 'ready (maintenance)' in read_only mode", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("read_only"),
        set: vi.fn(),
      } as any;

      server = buildServer({ corsOrigins: [], redis: mockRedis });
      healthyPings();
      await server.ready();

      const res = await server.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ready (maintenance)");
      expect(body.maintenance).toEqual({ mode: "read_only" });
    });

    it("returns 503 with status 'not ready' when a dependency is down (not maintenance)", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("off"),
        set: vi.fn(),
      } as any;

      server = buildServer({ corsOrigins: [], redis: mockRedis });
      failingPings();
      await server.ready();

      const res = await server.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe("not ready");
      expect(body).not.toHaveProperty("maintenance");
    });

    it("dependency failure during maintenance returns 503 'not ready' (failure beats maintenance)", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("full"),
        set: vi.fn(),
      } as any;

      server = buildServer({ corsOrigins: [], redis: mockRedis });
      failingPings();
      await server.ready();

      const res = await server.inject({ method: "GET", url: "/readyz" });
      // Dependency failure wins: status is not ready, http is 503
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe("not ready");
    });

    it("returns 200 with status 'ready' when off and deps healthy", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue("off"),
        set: vi.fn(),
      } as any;

      server = buildServer({ corsOrigins: [], redis: mockRedis });
      healthyPings();
      await server.ready();

      const res = await server.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ready");
      expect(res.json()).not.toHaveProperty("maintenance");
    });
  });
});
