import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, parseCorsOrigins, DEFAULT_CORS_ORIGINS } from "@/server";

const ALLOWED = "https://ipredict.app";
const DENIED = "https://evil.example";

let server: FastifyInstance | undefined;

function makeServer(corsOrigins: string[] = [ALLOWED]): FastifyInstance {
  server = buildServer({ corsOrigins });
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

describe("GET /healthz", () => {
  it("still returns ok", async () => {
    const app = makeServer();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
