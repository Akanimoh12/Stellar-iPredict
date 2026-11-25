import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMaintenanceMiddleware } from "./maintenance.js";
import type { MaintenanceState } from "../lib/maintenance.js";

function makeState(mode: string): MaintenanceState {
  return {
    getMode: vi.fn().mockResolvedValue(mode),
    setMode: vi.fn(),
  };
}

function buildApp(state: MaintenanceState, retryAfterSeconds = 120): FastifyInstance {
  const app = Fastify({ logger: false });

  // Health probe — always accessible
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  // Admin endpoint — always accessible
  app.get("/admin/maintenance", async () => ({ mode: "off" }));

  // Register maintenance middleware AFTER health routes
  registerMaintenanceMiddleware(app, { state, retryAfterSeconds });

  // Business route
  app.get("/api/v1/markets", async () => ({ markets: [] }));
  app.post("/api/v1/bets", async () => ({ ok: true }));
  app.delete("/api/v1/bets/1", async () => ({ ok: true }));

  return app;
}

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

// ── off mode ───────────────────────────────────────────────────────────────

describe("off mode", () => {
  beforeEach(() => { app = buildApp(makeState("off")); });

  it("passes GET requests through", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/markets" });
    expect(res.statusCode).toBe(200);
  });

  it("passes POST requests through", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/bets", payload: {} });
    expect(res.statusCode).toBe(200);
  });
});

// ── full mode ──────────────────────────────────────────────────────────────

describe("full mode", () => {
  beforeEach(() => { app = buildApp(makeState("full")); });

  it("blocks GET to business route with 503", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/markets" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("maintenance");
    expect(body.mode).toBe("full");
    expect(body.retryAfterSeconds).toBe(120);
  });

  it("sets Retry-After header equal to configured value", async () => {
    app = buildApp(makeState("full"), 300);
    const res = await app.inject({ method: "GET", url: "/api/v1/markets" });
    expect(res.headers["retry-after"]).toBe("300");
    expect(res.json().retryAfterSeconds).toBe(300);
  });

  it("allows /healthz through", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("allows /readyz through", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
  });

  it("allows /admin/maintenance through", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/maintenance" });
    expect(res.statusCode).toBe(200);
  });
});

// ── read_only mode ─────────────────────────────────────────────────────────

describe("read_only mode", () => {
  beforeEach(() => { app = buildApp(makeState("read_only")); });

  it("allows GET requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/markets" });
    expect(res.statusCode).toBe(200);
  });

  it("allows HEAD requests", async () => {
    const res = await app.inject({ method: "HEAD", url: "/api/v1/markets" });
    expect(res.statusCode).toBe(200);
  });

  it("allows OPTIONS requests", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/api/v1/markets" });
    // Not 503 — OPTIONS passes through read_only
    expect(res.statusCode).not.toBe(503);
  });

  it("blocks POST with 503 and correct body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/bets", payload: {} });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("maintenance");
    expect(body.mode).toBe("read_only");
  });

  it("blocks DELETE with 503", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/v1/bets/1" });
    expect(res.statusCode).toBe(503);
  });

  it("includes Retry-After header on blocked write", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/bets", payload: {} });
    expect(res.headers["retry-after"]).toBe("120");
  });

  /**
   * Vacuousness check: comment out the read_only write-block in maintenance.ts
   * and this test must fail.
   */
  it("[vacuousness] POST would pass if write-blocking were removed", async () => {
    // This test verifies the block is active. If read_only allowed writes it would
    // return 200 for POST, so we assert 503 here.
    const res = await app.inject({ method: "POST", url: "/api/v1/bets", payload: {} });
    expect(res.statusCode).toBe(503);
  });
});

// ── runtime mode switch ────────────────────────────────────────────────────

describe("runtime mode transitions (no restart)", () => {
  it("changes behaviour immediately when getMode returns a different value", async () => {
    const state = makeState("off");
    app = buildApp(state);

    // off → passes
    let res = await app.inject({ method: "POST", url: "/api/v1/bets", payload: {} });
    expect(res.statusCode).toBe(200);

    // switch to read_only
    vi.mocked(state.getMode).mockResolvedValue("read_only");
    res = await app.inject({ method: "POST", url: "/api/v1/bets", payload: {} });
    expect(res.statusCode).toBe(503);

    // switch to full
    vi.mocked(state.getMode).mockResolvedValue("full");
    res = await app.inject({ method: "GET", url: "/api/v1/markets" });
    expect(res.statusCode).toBe(503);

    // switch back to off
    vi.mocked(state.getMode).mockResolvedValue("off");
    res = await app.inject({ method: "GET", url: "/api/v1/markets" });
    expect(res.statusCode).toBe(200);
  });
});
