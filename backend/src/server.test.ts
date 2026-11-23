
import { describe, expect, it, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { registerGracefulShutdown } from "./server.js";
import { buildServer, parseCorsOrigins, DEFAULT_CORS_ORIGINS, EXPECTED_SECURITY_HEADERS } from "@/server";
import { createFakePool } from "./test/fakePool.js";

function makeFakeServer(close: ReturnType<typeof vi.fn>): FastifyInstance {
  return {
    close,
    addHook: vi.fn(),
    server: { closeAllConnections: vi.fn() },
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as FastifyInstance;
}

describe("registerGracefulShutdown", () => {
  it("closes the server once so Fastify stops accepting and drains in-flight requests", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const server = makeFakeServer(close);

    registerGracefulShutdown(server, {
      signals: ["SIGUSR2"],
      exitProcess: false,
      shutdownDatabase: false,
    });

    process.emit("SIGUSR2", "SIGUSR2");
    process.emit("SIGUSR2", "SIGUSR2");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("closes the database pool exactly once on graceful shutdown", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const shutdownDatabaseFn = vi.fn().mockResolvedValue(undefined);
    const server = makeFakeServer(close);

    registerGracefulShutdown(server, {
      signals: ["SIGUSR1"],
      exitProcess: false,
      shutdownDatabase: true,
      shutdownDatabaseFn,
    });

    process.emit("SIGUSR1", "SIGUSR1");
    process.emit("SIGUSR1", "SIGUSR1");

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(shutdownDatabaseFn).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the database pool even when server.close() fails partway through", async () => {
    const close = vi.fn().mockRejectedValue(new Error("Failed to drain HTTP connections"));
    const shutdownDatabaseFn = vi.fn().mockResolvedValue(undefined);
    const server = makeFakeServer(close);

    registerGracefulShutdown(server, {
      signals: ["SIGUSR2"],
      exitProcess: false,
      shutdownDatabase: true,
      shutdownDatabaseFn,
    });

    process.emit("SIGUSR2", "SIGUSR2");

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(shutdownDatabaseFn).toHaveBeenCalledTimes(1);
    });
  });

  it("forces closure and logs outstanding requests once the drain timeout elapses", async () => {
    const close = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const shutdownDatabaseFn = vi.fn().mockResolvedValue(undefined);
    const server = makeFakeServer(close);

    registerGracefulShutdown(server, {
      signals: ["SIGUSR1"],
      exitProcess: false,
      shutdownDatabase: true,
      shutdownDatabaseFn,
      drainTimeoutMs: 20,
    });

    process.emit("SIGUSR1", "SIGUSR1");

    await vi.waitFor(() => {
      expect((server as any).server.closeAllConnections).toHaveBeenCalled();
      expect(server.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ drainTimeoutMs: 20 }),
        expect.stringContaining("Drain timeout elapsed")
      );
      expect(shutdownDatabaseFn).toHaveBeenCalledTimes(1);
    });
  });

  it("importing db/pool.ts does not register any process-level signal listeners", async () => {
    const sigtermListenersBefore = process.listeners("SIGTERM").length;
    const sigintListenersBefore = process.listeners("SIGINT").length;

    await import("./db/pool.js");

    const sigtermListenersAfter = process.listeners("SIGTERM").length;
    const sigintListenersAfter = process.listeners("SIGINT").length;

    expect(sigtermListenersAfter).toBe(sigtermListenersBefore);
    expect(sigintListenersAfter).toBe(sigintListenersBefore);
  });
});

const ALLOWED = "https://ipredict.app";
const DENIED = "https://evil.example";

let server: FastifyInstance | undefined;

function makeServer(corsOrigins: string[] = [ALLOWED]): FastifyInstance {
  server = buildServer({ corsOrigins, pool: createFakePool() });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
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

  it("rejects wildcards in the origin allowlist", () => {
    expect(() => parseCorsOrigins("*")).toThrow(/wildcard origin/i);
    expect(() => parseCorsOrigins("https://a.app, *")).toThrow(/wildcard origin/i);
  });

  it("rejects wildcard when credentials are enabled", () => {
    expect(() => parseCorsOrigins("*", { credentials: true })).toThrow(/wildcard origin.*credentials/i);
  });

  it("fails server startup if credentials are enabled with a wildcard origin", () => {
    expect(() =>
      buildServer({
        corsOrigins: ["*"],
        corsCredentials: true,
        pool: createFakePool(),
      })
    ).toThrow(/wildcard origin/i);
  });

  it("rejects malformed origins with a clear message", () => {
    expect(() => parseCorsOrigins("not-a-url")).toThrow(/malformed/i);
    expect(() => parseCorsOrigins("ftp://example.com")).toThrow(/http: or https:/i);
    expect(() => parseCorsOrigins("https://example.com/api")).toThrow(/path component/i);
    expect(() => parseCorsOrigins("https://example.com/")).toThrow(/trailing slash/i);
    expect(() => parseCorsOrigins("https://example.com?foo=bar")).toThrow(/query parameters/i);
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
  it("asserts every configured security header is present with exact directive values", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    for (const [header, expectedValue] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
      expect(res.headers[header], `Mismatch on header "${header}"`).toBe(expectedValue);
    }
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("locks down the content security policy with exact directive string and no permissive defaults", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    const csp = res.headers["content-security-policy"];
    expect(csp).toBe(EXPECTED_SECURITY_HEADERS["content-security-policy"]);
    expect(csp).toBe("default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'");
    // helmet's defaults would otherwise re-permit what default-src 'none' denies.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("style-src");
    expect(csp).not.toContain("img-src");
    expect(csp).not.toContain("font-src");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("object-src");
  });

  it("asserts exact HSTS directives (180 days with includeSubDomains)", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.headers["strict-transport-security"]).toBe(
      EXPECTED_SECURITY_HEADERS["strict-transport-security"]
    );
    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000; includeSubDomains");
  });

  it("does not leak the server implementation", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("carries all security headers on error responses (404 Not Found)", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/non-existent-server-endpoint" });

    expect(res.statusCode).toBe(404);
    for (const [header, expectedValue] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
      expect(res.headers[header], `Mismatch on 404 header "${header}"`).toBe(expectedValue);
    }
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("carries all security headers on method not allowed error responses (405 Method Not Allowed)", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "DELETE", url: "/healthz" });

    expect(res.statusCode).toBe(405);
    for (const [header, expectedValue] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
      expect(res.headers[header], `Mismatch on 405 header "${header}"`).toBe(expectedValue);
    }
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("fails verification if useDefaults: false is removed and helmet default directives are merged", async () => {
    // Replicate helmet configuration without useDefaults: false
    const weakApp = Fastify();
    await weakApp.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
          "frame-ancestors": ["'none'"],
        },
      },
    });
    weakApp.get("/probe", async () => ({ status: "ok" }));
    const res = await weakApp.inject({ method: "GET", url: "/probe" });
    await weakApp.close();

    const weakCsp = res.headers["content-security-policy"];
    // Omitting useDefaults: false merges permissive defaults that undermine default-src: none
    expect(weakCsp).not.toBe(EXPECTED_SECURITY_HEADERS["content-security-policy"]);
    expect(weakCsp).toContain("script-src");
    expect(weakCsp).toContain("style-src");
  });

  it("fails verification if HSTS is weakened or includeSubDomains is removed", () => {
    const weakened1 = "max-age=15552000"; // missing includeSubDomains
    const weakened2 = "max-age=3600; includeSubDomains"; // shortened max-age
    expect(weakened1).not.toBe(EXPECTED_SECURITY_HEADERS["strict-transport-security"]);
    expect(weakened2).not.toBe(EXPECTED_SECURITY_HEADERS["strict-transport-security"]);
  });

  it("fails verification if Referrer-Policy is relaxed", () => {
    const relaxed = "strict-origin-when-cross-origin";
    expect(relaxed).not.toBe(EXPECTED_SECURITY_HEADERS["referrer-policy"]);
  });

  it("fails verification if frame-ancestors is relaxed or omitted", () => {
    const relaxed = "default-src 'none';base-uri 'none';form-action 'none'";
    expect(relaxed).not.toBe(EXPECTED_SECURITY_HEADERS["content-security-policy"]);
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

describe("request body size limits", () => {
  it("rejects requests exceeding body limit with 413 in standard error envelope", async () => {
    const app = buildServer({
      corsOrigins: [ALLOWED],
      pool: createFakePool(),
      bodyLimit: 100,
    });

    const oversizedPayload = JSON.stringify({ data: "x".repeat(200) });
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { "content-type": "application/json" },
      payload: oversizedPayload,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: expect.any(String),
      },
    });

    await app.close();
  });

  it("allows legitimate requests within the body limit", async () => {
    const app = buildServer({
      corsOrigins: [ALLOWED],
      pool: createFakePool(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ marketId: 1 }),
    });

    expect(res.statusCode).not.toBe(413);

    await app.close();
  });
});
