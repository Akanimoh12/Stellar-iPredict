import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));

vi.mock("../db/bets.js", () => ({ getBetsByBettor: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: { query: poolQueryMock } }));

import { buildServer } from "../server.js";
import {
  RouteTable,
  createNotFoundHandler,
  errorHandler,
  mapError,
  normalizePath,
  type FastifyReplyLike,
} from "./errors.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

interface RecordedReply extends FastifyReplyLike {
  statusCode?: number;
  headers: Record<string, string>;
  payload?: unknown;
}

function makeReply(): RecordedReply {
  const reply: RecordedReply = {
    headers: {},
    status(code) {
      reply.statusCode = code;
      return reply;
    },
    header(name, value) {
      reply.headers[name] = value;
      return reply;
    },
    send(payload) {
      reply.payload = payload;
      return reply;
    },
  };

  return reply;
}

function handle(routes: RouteTable, method: string, url: string): RecordedReply {
  const reply = makeReply();
  createNotFoundHandler(routes)({ method, url }, reply);
  return reply;
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe("normalizePath", () => {
  it("drops the query string", () => {
    expect(normalizePath("/markets?page=2")).toBe("/markets");
  });

  it("drops a trailing slash", () => {
    expect(normalizePath("/markets/")).toBe("/markets");
  });

  it("keeps the root path", () => {
    expect(normalizePath("/")).toBe("/");
  });
});

describe("dependency errors", () => {
  it("maps driver connection failures to 503 without leaking details", () => {
    const mapped = mapError(Object.assign(new Error("password=secret host=db"), { code: "ECONNREFUSED" }));
    expect(mapped).toEqual({ statusCode: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable" });
  });

  it("adds Retry-After to dependency failures", () => {
    const reply = makeReply();
    errorHandler(Object.assign(new Error("db details"), { code: "57P01" }), { method: "GET", url: "/", id: "req-1" }, reply);
    expect(reply.statusCode).toBe(503);
    expect(reply.headers["Retry-After"]).toBe("5");
    expect(reply.payload).not.toMatchObject({ error: { message: "db details" } });
  });

  it("keeps application bugs at 500", () => {
    expect(mapError(new Error("bug"))).toMatchObject({ statusCode: 500, code: "INTERNAL_SERVER_ERROR" });
  });
});

describe("errorHandler request id", () => {
  it("includes the request id in the body and the response header", () => {
    const reply = makeReply();
    errorHandler(new Error("bug"), { method: "GET", url: "/", id: "req-42" }, reply);

    expect(reply.payload).toMatchObject({ error: { requestId: "req-42" } });
    expect(reply.headers["x-request-id"]).toBe("req-42");
  });

  it("falls back to 'unknown' when the request carries no id", () => {
    const reply = makeReply();
    errorHandler(new Error("bug"), { method: "GET", url: "/" }, reply);

    expect(reply.payload).toMatchObject({ error: { requestId: "unknown" } });
  });
});

describe("RouteTable", () => {
  it("matches parametric segments", () => {
    const routes = new RouteTable();
    routes.add({ method: "GET", url: "/api/v1/profile/:address" });

    expect(routes.allowedMethods("/api/v1/profile/GABC")).toEqual(["GET"]);
    expect(routes.allowedMethods("/api/v1/profile/GABC/bets")).toEqual([]);
  });

  it("collects every method registered for one path", () => {
    const routes = new RouteTable();
    routes.add({ method: "GET", url: "/api/v1/markets" });
    routes.add({ method: ["POST", "PUT"], url: "/api/v1/markets" });

    expect(routes.allowedMethods("/api/v1/markets")).toEqual(["GET", "POST", "PUT"]);
  });

  it("ignores catch-all routes", () => {
    const routes = new RouteTable();
    // @fastify/cors registers this for preflight; treating it as a real route
    // would make every unknown path answer 405 instead of 404.
    routes.add({ method: "OPTIONS", url: "*" });

    expect(routes.allowedMethods("/anything")).toEqual([]);
  });

  it("reports nothing for a path with no route", () => {
    const routes = new RouteTable();
    routes.add({ method: "GET", url: "/healthz" });

    expect(routes.allowedMethods("/nope")).toEqual([]);
  });
});

describe("createNotFoundHandler", () => {
  it("answers an unknown path with 404", () => {
    const routes = new RouteTable();
    routes.add({ method: "GET", url: "/healthz" });

    const reply = handle(routes, "GET", "/nope");

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(reply.headers.Allow).toBeUndefined();
  });

  it("answers a known path with an unknown method with 405 and Allow", () => {
    const routes = new RouteTable();
    routes.add({ method: "GET", url: "/healthz" });

    const reply = handle(routes, "DELETE", "/healthz");

    expect(reply.statusCode).toBe(405);
    expect(reply.payload).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
    expect(reply.headers.Allow).toBe("GET");
  });

  it("lists every allowed method in Allow", () => {
    const routes = new RouteTable();
    routes.add({ method: ["GET", "POST"], url: "/api/v1/markets" });

    expect(handle(routes, "DELETE", "/api/v1/markets").headers.Allow).toBe("GET, POST");
  });

  it("ignores the query string when matching", () => {
    const routes = new RouteTable();
    routes.add({ method: "GET", url: "/api/v1/markets" });

    expect(handle(routes, "PATCH", "/api/v1/markets?page=2").statusCode).toBe(405);
  });
});

// ── Wired into the server ─────────────────────────────────────────────────────

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("unknown routes on the built server", () => {
  it("returns the error envelope for an unknown path", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({ method: "GET", url: "/does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(res.json().error.requestId).toBeTruthy();
    expect(res.headers["x-request-id"]).toBe(res.json().error.requestId);
  });

  it("returns 405 for a known path called with the wrong method", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({ method: "DELETE", url: "/healthz" });

    expect(res.statusCode).toBe(405);
    expect(res.json().error.code).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers.allow).toContain("GET");
  });

  it("still serves the route it knows", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
  });
});
