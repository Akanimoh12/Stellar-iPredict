import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@/server";
import {
  REQUEST_ID_HEADER,
  MAX_REQUEST_ID_LENGTH,
  createLoggerOptions,
  genReqId,
  isValidRequestId,
  resolveRequestId,
} from "@/lib/log";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("isValidRequestId", () => {
  it("accepts a generated uuid", () => {
    expect(isValidRequestId("6f1b1f5c-2f7d-4c1a-9a0e-6b7f0a1c2d3e")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidRequestId("")).toBe(false);
  });

  it("rejects ids that are too long", () => {
    expect(isValidRequestId("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBe(false);
  });

  it("rejects control characters that would corrupt log lines", () => {
    expect(isValidRequestId("abc\ndef")).toBe(false);
    expect(isValidRequestId("abc def")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(42)).toBe(false);
  });
});

describe("resolveRequestId", () => {
  it("reuses a valid inbound id", () => {
    expect(resolveRequestId("trace-abc-123")).toBe("trace-abc-123");
  });

  it("generates a uuid when the header is absent", () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_PATTERN);
  });

  it("generates a uuid when the inbound id is malformed", () => {
    expect(resolveRequestId("bad id\n")).toMatch(UUID_PATTERN);
  });

  it("uses the first value when the header is repeated", () => {
    expect(resolveRequestId(["first", "second"])).toBe("first");
  });

  it("generates unique ids", () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});

describe("genReqId", () => {
  it("reads the correlation id off the raw request headers", () => {
    expect(genReqId({ headers: { [REQUEST_ID_HEADER]: "inbound-1" } })).toBe("inbound-1");
  });

  it("falls back to a generated id", () => {
    expect(genReqId({ headers: {} })).toMatch(UUID_PATTERN);
  });
});

describe("createLoggerOptions", () => {
  it("uses LOG_LEVEL", () => {
    expect(createLoggerOptions({ LOG_LEVEL: "debug" }).level).toBe("debug");
  });

  it("defaults to info", () => {
    expect(createLoggerOptions({}).level).toBe("info");
  });

  it("stays silent under test so suites are not flooded", () => {
    expect(createLoggerOptions({ NODE_ENV: "test", LOG_LEVEL: "debug" }).level).toBe("silent");
  });

  it("redacts credential-bearing headers", () => {
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers.authorization");
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers.cookie");
  });
});

describe("request correlation id over HTTP", () => {
  it("returns a generated id when the caller sends none", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({ method: "GET", url: "/healthz" });

    expect(res.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("echoes back a caller-supplied id", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { [REQUEST_ID_HEADER]: "frontend-trace-7" },
    });

    expect(res.headers[REQUEST_ID_HEADER]).toBe("frontend-trace-7");
  });

  it("does not echo a malformed caller-supplied id", async () => {
    server = buildServer({ corsOrigins: [] });

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { [REQUEST_ID_HEADER]: "not a valid id" },
    });

    expect(res.headers[REQUEST_ID_HEADER]).not.toBe("not a valid id");
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("gives concurrent requests distinct ids", async () => {
    server = buildServer({ corsOrigins: [] });

    const [first, second] = await Promise.all([
      server.inject({ method: "GET", url: "/healthz" }),
      server.inject({ method: "GET", url: "/healthz" }),
    ]);

    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
  });

  it("logs one completion line carrying the correlation id", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildServer({ corsOrigins: [], logger: { level: "info", stream } });

    await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { [REQUEST_ID_HEADER]: "trace-log-1" },
    });

    const completed = lines.filter((line) => line.requestId === "trace-log-1");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      msg: "request completed",
      method: "GET",
      url: "/healthz",
      statusCode: 200,
      // Fastify binds the same id onto every log line the request produces.
      reqId: "trace-log-1",
    });
    expect(completed[0].responseTimeMs).toBeTypeOf("number");
  });
});
