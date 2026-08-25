
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerGracefulShutdown } from "../server.js";
import { buildServer, parseCorsOrigins, DEFAULT_CORS_ORIGINS } from "@/server";
import { resetErrorCounts, resetHistogram } from "../metrics.js";

describe("registerGracefulShutdown", () => {
  it("closes the server once so Fastify stops accepting and drains in-flight requests", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const server = {
      close,
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as FastifyInstance;

    registerGracefulShutdown(server, {
      signals: ["SIGUSR2"],
      exitProcess: false,
      shutdownDatabase: false,
    });

    process.emit("SIGUSR2", "SIGUSR2");
    process.emit("SIGUSR2", "SIGUSR2");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});

const ALLOWED = "https://ipredict.app";
const DENIED = "https://evil.example";

let server: FastifyInstance | undefined;

beforeEach(() => {
  resetHistogram();
  resetErrorCounts();
});

function makeServer(corsOrigins: string[] = [ALLOWED]): FastifyInstance {
  server = buildServer({ corsOrigins });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  resetHistogram();
  resetErrorCounts();
});

describe("parseCorsOrigins", () => {
  it("falls back to the local frontend when unset", () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS);
  });

  it("splits a comma-separated list and trims whitespace", () => {
    expect(parseCorsOrigins("https://a.app, https://b.app")).toEqual([
      "https://a.app",
      "https://b.app",
    ]);
  });

  it("drops empty entries", () => {
    expect(parseCorsOrigins("https://a.app,,  ,")).toEqual(["https://a.app"]);
  });

  it("allows no origin when explicitly empty", () => {
    expect(parseCorsOrigins("")).toEqual([]);
  });
});

describe("CORS", () => {
  it("allows an allowlisted origin", async () => {
    const app = makeServer();

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ALLOWED },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("omits CORS headers for a non-allowlisted origin", async () => {
    const app = makeServer();

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: DENIED },
    });

    // The request still succeeds; the browser blocks the read because no
    // Access-Control-Allow-Origin came back.
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never returns a wildcard origin", async () => {
    const app = makeServer([ALLOWED, "https://staging.ipredict.app"]);

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://staging.ipredict.app" },
    });

    expect(res.headers["access-control-allow-origin"]).toBe("https://staging.ipredict.app");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("answers preflight for an allowlisted origin", async () => {
    const app = makeServer();

    const res = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("serves clients that send no Origin header", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    // Nothing to grant: no Origin means no browser is applying CORS, and a
    // wildcard here would be a needlessly permissive header to publish.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("security headers", () => {
  it("sets the standard helmet headers", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toContain("max-age=15552000");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("locks down the content security policy", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // helmet's defaults would otherwise re-permit what default-src 'none' denies.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("does not leak the server implementation", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("GET /healthz", () => {
  it("still returns ok", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

  });
});

describe("GET /api/metrics", () => {
  it("returns a Prometheus scrape with business counters and request histograms", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            markets_created_total: "7",
            bets_placed_total: "15",
            volume_xlm_total: "321.0000000",
            markets_resolved_total: "4",
          },
        ],
      }),
    };

    const app = buildServer({ corsOrigins: [ALLOWED], pool: pool as any });

    await app.inject({ method: "GET", url: "/healthz" });
    const res = await app.inject({ method: "GET", url: "/api/metrics" });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/plain");
    expect(res.body).toContain("markets_created_total 7");
    expect(res.body).toContain("bets_placed_total 15");
    expect(res.body).toContain("volume_xlm_total 321.0000000");
    expect(res.body).toContain("markets_resolved_total 4");
    expect(res.body).toContain('api_request_duration_ms_count{route="GET /healthz"} 1');
  });

  it("fails loudly when the metrics endpoint has no database pool", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/metrics" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Metrics database not available",
      },
    });
  });
});
