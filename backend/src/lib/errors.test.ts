import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));

vi.mock("../db/bets.js", () => ({ getBetsByBettor: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: { query: poolQueryMock } }));

import { buildServer } from "../server.js";
import { createFakePool } from "../test/fakePool.js";
import {
  RouteTable,
  badRequest,
  conflict,
  createNotFoundHandler,
  errorHandler,
  isDatabaseDriverError,
  mapError,
  normalizePath,
  notFound,
  type FastifyErrorLike,
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

  it("maps Fastify payload too large errors to 413 PAYLOAD_TOO_LARGE", () => {
    const error = Object.assign(new Error("request body larger than max allowable size"), {
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
      statusCode: 413,
    });
    expect(mapError(error)).toEqual({
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "request body larger than max allowable size",
    });
  });

  it("maps Fastify request timeout errors to 408 REQUEST_TIMEOUT", () => {
    const error = Object.assign(new Error("request timed out"), {
      code: "FST_ERR_REQ_TIMEOUT",
      statusCode: 408,
    });
    expect(mapError(error)).toEqual({
      statusCode: 408,
      code: "REQUEST_TIMEOUT",
      message: "request timed out",
    });
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

// ── Internal-detail leakage ──────────────────────────────────────────────────
//
// The envelope is the only thing a client sees, so these tests assert on the
// serialised response rather than on `mapError`'s return value. Asserting on
// the mapped object alone would miss a leak added later in the handler.
//
// `mapError` already replaces 5xx messages, but 4xx messages pass through — so
// the question every test here answers is: for an error we did *not* write,
// does anything about our schema, our queries, or our process reach the client?

/** Substrings that must never appear in a client-visible error response. */
const FORBIDDEN = [
  // Stack frames and engine internals.
  "at Object.", "at Module.", "at Function.", ".ts:", ".js:", "node_modules",
  "node:internal", "    at ",
  // Schema and database internals.
  "SELECT ", "INSERT ", "UPDATE ", "DELETE ", "FROM markets", "WHERE ",
  "oracle_submissions", "council_votes", "markets", "constraint", "duplicate key",
  "violates", "SQLSTATE", "pg.", "node-postgres", "relation ", "column ",
  // Connection strings / credentials.
  "password", "postgres://", "ECONNREFUSED",
] as const;

/** Asserts a rendered response body leaks nothing internal. */
function expectNoInternalDetail(body: unknown, label: string): void {
  const serialised = typeof body === "string" ? body : JSON.stringify(body);
  for (const needle of FORBIDDEN) {
    expect(
      serialised.includes(needle),
      `${label}: response leaked ${JSON.stringify(needle)}\n  body: ${serialised}`,
    ).toBe(false);
  }
}

/** Runs an error through the real handler and asserts the reply is clean. */
function handleError(error: Error, label: string): RecordedReply {
  const reply = makeReply();
  errorHandler(error as FastifyErrorLike, { method: "POST", url: "/api/oracle/submit", id: "req-1" }, reply);
  expectNoInternalDetail(reply.payload, label);
  return reply;
}

/** A Postgres error as `pg` actually produces it. */
function pgError(
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
): Error & Record<string, unknown> {
  return Object.assign(new Error(message), { code, severity: "ERROR", ...extra }) as unknown as Error &
    Record<string, unknown>;
}

describe("database errors never surface their text", () => {
  it("does not forward a unique-violation message that names the constraint, table and column", () => {
    // The concrete case: Postgres reports which unique constraint was tripped,
    // which discloses the table, the constraint and the key column.
    const error = pgError(
      'duplicate key value violates unique constraint "uq_oracle_submissions_market_id"\nDETAIL:  Key (market_id)=(1) already exists.',
      "23505",
      {
        constraint: "uq_oracle_submissions_market_id",
        table: "oracle_submissions",
        column: "market_id",
        detail: "Key (market_id)=(1) already exists.",
        position: "42",
      },
    );

    const reply = handleError(error, "unique violation");
    expect(reply.statusCode).toBe(500);
    expect(reply.payload).toMatchObject({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
    });
  });

  it("does not forward a foreign-key violation naming the referenced relation", () => {
    const error = pgError(
      'insert or update on table "markets" violates foreign key constraint "oracle_submissions_market_id_fkey"',
      "23503",
      { table: "markets", constraint: "oracle_submissions_market_id_fkey", schema: "public" },
    );

    const reply = handleError(error, "foreign key violation");
    expectNoInternalDetail(reply.payload, "foreign key violation");
    expect(reply.statusCode).toBe(500);
  });

  it("does not forward a syntax error carrying the offending SQL", () => {
    const error = pgError('syntax error at or near "FROMM"', "42601", { position: "8" });

    const reply = handleError(error, "syntax error");
    expect(reply.payload).toMatchObject({ error: { message: "Internal server error" } });
  });

  it("does not surface a SQLSTATE as a client-facing code", () => {
    // `23505` means nothing outside this service, and echoing it invites a
    // client to branch on a database implementation detail.
    const mapped = mapError(pgError("duplicate key", "23505"));

    expect(mapped.code).not.toBe("23505");
    expect(mapped.code).toMatch(/^[A-Z_]+$/);
  });

  it("replaces the message even when a driver error is given a 4xx status", () => {
    // The pass-through is keyed on 4xx, so a driver error that arrives with
    // one is exactly the case that could leak. It must not.
    const error = Object.assign(
      pgError(
        'duplicate key value violates unique constraint "uq_oracle_submissions_market_id"',
        "23505",
        { constraint: "uq_oracle_submissions_market_id" },
      ),
      { statusCode: 409 },
    );

    const reply = handleError(error, "driver error with 4xx status");
    expect(reply.statusCode).toBe(409);
    expect(reply.payload).toMatchObject({ error: { code: "CONFLICT" } });
    expect(reply.payload).not.toMatchObject({ error: { message: expect.stringContaining("uq_") } });
  });

  it("does not leak through the 4xx path for any SQLSTATE class", () => {
    const codes = ["23505", "23503", "23502", "42P01", "22P02", "40001", "57014", "08006"];

    for (const code of codes) {
      const error = Object.assign(pgError(`driver detail for ${code}`, code), { statusCode: 400 });
      const reply = handleError(error, `sqlstate ${code}`);
      expect(reply.payload).not.toMatchObject({
        error: { message: expect.stringContaining(`driver detail for ${code}`) },
      });
    }
  });

  it("does not leak a connection string or credentials from a driver error", () => {
    const error = pgError("connection to server at postgres://app:hunter2@10.0.0.5:5432 failed", "08006", {
      host: "10.0.0.5",
    });

    const reply = handleError(error, "connection string");
    // 08006 is a connection failure, so it is classified as a dependency outage
    // (503) rather than a generic 500 — either way, nothing internal escapes.
    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toMatchObject({ error: { message: "Service temporarily unavailable" } });
    expect(reply.payload).not.toMatchObject({ error: { message: expect.stringContaining("hunter2") } });
  });

  it("does not leak credentials from a driver error on the 5xx path", () => {
    const error = pgError("FATAL: password authentication failed for user \"app\"", "28P01", {
      user: "app",
    });

    const reply = handleError(error, "auth failure");

    expect(reply.payload).toMatchObject({ error: { message: "Internal server error" } });
    expect(reply.payload).not.toMatchObject({ error: { message: expect.stringContaining("app") } });
  });

  it("never leaks a stack trace, whatever the status", () => {
    for (const statusCode of [400, 404, 409, 422, 500, 503]) {
      const error = Object.assign(
        new Error("something broke"),
        { statusCode, stack: "Error: something broke\n    at handler (/srv/app/src/db/oracle.ts:120:15)" },
      );
      handleError(error, `stack at ${statusCode}`);
    }
  });
});

describe("isDatabaseDriverError", () => {
  it("identifies a Postgres error by its diagnostic fields", () => {
    expect(isDatabaseDriverError(pgError("x", "23505"))).toBe(true);
    expect(isDatabaseDriverError(Object.assign(new Error("x"), { constraint: "c" }))).toBe(true);
    expect(isDatabaseDriverError(Object.assign(new Error("x"), { table: "markets" }))).toBe(true);
  });

  it("identifies a Postgres error by a SQLSTATE-shaped code", () => {
    for (const code of ["23505", "42P01", "08006", "57014"]) {
      expect(isDatabaseDriverError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("does not misidentify our own errors", () => {
    expect(isDatabaseDriverError(badRequest("bad"))).toBe(false);
    expect(isDatabaseDriverError(notFound("gone"))).toBe(false);
    expect(isDatabaseDriverError(conflict("duplicate"))).toBe(false);
  });

  it("does not misidentify Fastify's own errors", () => {
    expect(
      isDatabaseDriverError(Object.assign(new Error("too large"), { code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 })),
    ).toBe(false);
  });

  it("treats a plain application error as ours, not the database's", () => {
    expect(isDatabaseDriverError(new Error("bug"))).toBe(false);
  });
});

describe("4xx messages are safe and still useful", () => {
  it("keeps a message we authored", () => {
    // Our own errors are the whole point of the curated-message approach: the
    // client is told what to fix.
    expect(mapError(badRequest("id must be a positive integer"))).toEqual({
      statusCode: 400,
      code: "BAD_REQUEST",
      message: "id must be a positive integer",
    });
  });

  it("keeps a Fastify schema validation message, which describes the request", () => {
    const error = Object.assign(new Error("limit must be less than or equal to 100"), {
      code: "FST_ERR_VALIDATION",
      statusCode: 400,
    });

    const mapped = mapError(error);

    expect(mapped.code).toBe("BAD_REQUEST");
    expect(mapped.message).toBe("limit must be less than or equal to 100");
    expectNoInternalDetail(mapped, "schema validation");
  });

  it("keeps the payload-too-large and timeout messages", () => {
    expect(mapError(Object.assign(new Error("request body larger than max allowable size"), { code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 })).message)
      .toBe("request body larger than max allowable size");
    expect(mapError(Object.assign(new Error("request timed out"), { code: "FST_ERR_REQ_TIMEOUT", statusCode: 408 })).message)
      .toBe("request timed out");
  });

  it("does not pass a 4xx message through when it is a driver error, but stays informative", () => {
    const error = Object.assign(pgError("duplicate key value violates unique constraint uq_x", "23505"), {
      statusCode: 409,
    });

    const mapped = mapError(error);

    // Useful to a client: it knows the status and that it should not retry
    // blindly. Not useful to an attacker: no schema.
    expect(mapped.statusCode).toBe(409);
    expect(mapped.message).toBe("Conflict");
    expectNoInternalDetail(mapped, "driver error 409");
  });

  it("uses a curated message per status for driver errors", () => {
    const cases: Array<[number, string, string]> = [
      [401, "UNAUTHORIZED", "Unauthorized"],
      [403, "FORBIDDEN", "Forbidden"],
      [404, "NOT_FOUND", "Not found"],
      [409, "CONFLICT", "Conflict"],
    ];

    for (const [statusCode, code, message] of cases) {
      const error = Object.assign(pgError("driver text", "23505"), { statusCode });
      expect(mapError(error)).toEqual({ statusCode, code, message });
    }
  });
});

describe("errors from each origin", () => {
  it("hides an application bug at 500", () => {
    const reply = handleError(new Error("Cannot read properties of undefined (reading 'total_yes')"), "app bug");
    expect(reply.statusCode).toBe(500);
    expect(reply.payload).toMatchObject({ error: { message: "Internal server error" } });
  });

  it("hides a validator failure that escaped as a driver-style error", () => {
    // A validator wrapping a DB lookup can surface the driver's own error.
    const error = Object.assign(new Error('relation "bets" does not exist'), { code: "42P01" });
    const reply = handleError(error, "validator");
    expect(reply.payload).toMatchObject({ error: { message: "Internal server error" } });
  });

  it("keeps every response in the standard envelope", () => {
    for (const error of [
      new Error("bug"),
      pgError("duplicate key", "23505"),
      badRequest("bad input"),
      notFound("missing"),
    ]) {
      const reply = handleError(error, "envelope shape");
      expect(Object.keys(reply.payload as object)).toEqual(["error"]);
      expect(Object.keys((reply.payload as { error: object }).error).sort()).toEqual([
        "code",
        "message",
        "requestId",
      ]);
    }
  });

  it("correlates a redacted error with its server-side log via the request id", () => {
    // The client gets a generic message, but the request id ties it to the
    // detail the server logged — so redaction costs nothing operationally.
    const reply = handleError(pgError("duplicate key value violates uq_x", "23505"), "correlation");
    expect((reply.payload as { error: { requestId: string } }).error.requestId).toBe("req-1");
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
    server = buildServer({ corsOrigins: [], pool: createFakePool(poolQueryMock) });

    const res = await server.inject({ method: "GET", url: "/does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(res.json().error.requestId).toBeTruthy();
    expect(res.headers["x-request-id"]).toBe(res.json().error.requestId);
  });

  it("returns 405 for a known path called with the wrong method", async () => {
    server = buildServer({ corsOrigins: [], pool: createFakePool(poolQueryMock) });

    const res = await server.inject({ method: "DELETE", url: "/healthz" });

    expect(res.statusCode).toBe(405);
    expect(res.json().error.code).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers.allow).toContain("GET");
  });

  it("still serves the route it knows", async () => {
    server = buildServer({ corsOrigins: [], pool: createFakePool(poolQueryMock) });

    const res = await server.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
  });
});
