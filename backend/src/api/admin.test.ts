import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { createAdminRoutes } from "./admin.js";
import type { MaintenanceState } from "../lib/maintenance.js";

function buildTestServer(
  maintenanceState: MaintenanceState,
  adminSecret?: string
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(createAdminRoutes({ maintenanceState, adminSecret }));
  return app;
}

describe("Admin maintenance routes", () => {
  let app: FastifyInstance;
  let mockState: MaintenanceState;
  const SECRET = "a-long-enough-secret-for-testing-purposes";

  beforeEach(() => {
    mockState = {
      getMode: vi.fn().mockResolvedValue("off"),
      setMode: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await app?.close();
  });

  describe("when no admin secret is configured", () => {
    it("does not register any admin routes", async () => {
      app = buildTestServer(mockState, undefined);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/admin/maintenance" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /admin/maintenance", () => {
    beforeEach(() => {
      app = buildTestServer(mockState, SECRET);
    });

    it("returns 401 with no Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/maintenance" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with wrong secret", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/maintenance",
        headers: { authorization: "Bearer wrong-secret" },
      });
      expect(res.statusCode).toBe(401);
      // Must not leak mode
      const body = res.json();
      expect(body).not.toHaveProperty("mode");
    });

    it("returns 401 with malformed Authorization header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/maintenance",
        headers: { authorization: SECRET },   // missing "Bearer " prefix
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with current mode on valid credentials", async () => {
      vi.mocked(mockState.getMode).mockResolvedValue("read_only");

      const res = await app.inject({
        method: "GET",
        url: "/admin/maintenance",
        headers: { authorization: `Bearer ${SECRET}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mode: "read_only" });
    });
  });

  describe("PUT /admin/maintenance", () => {
    beforeEach(() => {
      app = buildTestServer(mockState, SECRET);
    });

    it("returns 401 with no Authorization header", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/maintenance",
        payload: { mode: "full" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with wrong secret and does not leak mode", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/maintenance",
        headers: { authorization: "Bearer bad-secret" },
        payload: { mode: "full" },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).not.toHaveProperty("mode");
      expect(mockState.setMode).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid mode value", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/maintenance",
        headers: { authorization: `Bearer ${SECRET}` },
        payload: { mode: "banana" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("sets mode and returns old and new mode on valid request", async () => {
      vi.mocked(mockState.getMode).mockResolvedValue("off");

      const res = await app.inject({
        method: "PUT",
        url: "/admin/maintenance",
        headers: { authorization: `Bearer ${SECRET}` },
        payload: { mode: "read_only" },
      });

      expect(res.statusCode).toBe(200);
      expect(mockState.setMode).toHaveBeenCalledWith("read_only");
      const body = res.json();
      expect(body.mode).toBe("read_only");
      expect(body.previous).toBe("off");
    });

    it("cycles through all three modes", async () => {
      vi.mocked(mockState.getMode)
        .mockResolvedValueOnce("off")
        .mockResolvedValueOnce("read_only")
        .mockResolvedValueOnce("full");

      for (const [from, to] of [
        ["off", "read_only"],
        ["read_only", "full"],
        ["full", "off"],
      ] as const) {
        const res = await app.inject({
          method: "PUT",
          url: "/admin/maintenance",
          headers: { authorization: `Bearer ${SECRET}` },
          payload: { mode: to },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().previous).toBe(from);
        expect(res.json().mode).toBe(to);
      }
    });
  });
});
