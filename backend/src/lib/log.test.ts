import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  REQUEST_ID_HEADER,
  MAX_REQUEST_ID_LENGTH,
  REDACTED_HEADERS,
  DEFAULT_ALLOWED_QUERY_PARAMS,
  sanitizeUrl,
  resolveRoutePattern,
  createLoggerOptions,
  genReqId,
  isValidRequestId,
  resolveRequestId,
  registerRequestLogging,
} from "./log.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function buildTestApp(options: { logger?: FastifyServerOptions["logger"] } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? createLoggerOptions(),
    genReqId,
    disableRequestLogging: true,
  });

  registerRequestLogging(app);

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/markets/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { id, name: "Sample Market" };
  });
  app.get("/empty-204", async (_req, reply) => {
    reply.status(204).send();
  });
  app.post("/submit", async (request, reply) => {
    reply.status(200).send({ received: request.body });
  });

  return app;
}

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
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers['set-cookie']");
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers['x-api-key']");
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers['api-key']");
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers['x-oracle-api-key']");
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers['proxy-authorization']");
    expect(createLoggerOptions({}).redact.paths).toContain("req.headers['x-auth-token']");
  });
});

describe("sanitizeUrl", () => {
  it("leaves URLs without query parameters untouched", () => {
    expect(sanitizeUrl("/api/markets")).toBe("/api/markets");
    expect(sanitizeUrl("/healthz")).toBe("/healthz");
  });

  it("preserves allowed query parameters", () => {
    const url = "/api/markets?page=1&limit=20&status=active&sort=newest";
    expect(sanitizeUrl(url)).toBe(url);
  });

  it("redacts sensitive query parameters (allowlist enforcement)", () => {
    expect(sanitizeUrl("/api/oracle/submit?apiKey=super-secret")).toBe(
      "/api/oracle/submit?apiKey=[redacted]",
    );
    expect(sanitizeUrl("/api/user?token=secret-token-123")).toBe(
      "/api/user?token=[redacted]",
    );
    expect(sanitizeUrl("/api/auth?password=mypassword&secret=xyz")).toBe(
      "/api/auth?password=[redacted]&secret=[redacted]",
    );
  });

  it("handles mixed allowed and sensitive query parameters", () => {
    const input = "/api/markets?page=2&apiKey=secret123&limit=50&auth=token789";
    const expected = "/api/markets?page=2&apiKey=[redacted]&limit=50&auth=[redacted]";
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it("performs case-insensitive parameter matching", () => {
    expect(sanitizeUrl("/api/markets?Page=2&LIMIT=10")).toBe("/api/markets?Page=2&LIMIT=10");
    expect(sanitizeUrl("/api/markets?APIKEY=secret")).toBe("/api/markets?APIKEY=[redacted]");
  });

  it("preserves URL fragments", () => {
    expect(sanitizeUrl("/api/markets?page=1&apiKey=secret#details")).toBe(
      "/api/markets?page=1&apiKey=[redacted]#details",
    );
  });

  it("handles empty values and parameters without values", () => {
    expect(sanitizeUrl("/api/markets?apiKey")).toBe("/api/markets?apiKey=[redacted]");
    expect(sanitizeUrl("/api/markets?apiKey=")).toBe("/api/markets?apiKey=[redacted]");
    expect(sanitizeUrl("/api/markets?status=")).toBe("/api/markets?status=");
  });

  it("accepts a custom allowlist", () => {
    const custom = new Set(["custom_param"]);
    expect(sanitizeUrl("/api?custom_param=ok&page=1", custom)).toBe(
      "/api?custom_param=ok&page=[redacted]",
    );
  });
});

describe("resolveRoutePattern", () => {
  it("returns routeOptions.url when available", () => {
    expect(resolveRoutePattern({ routeOptions: { url: "/api/markets/:id" }, url: "/api/markets/12" })).toBe(
      "/api/markets/:id",
    );
  });

  it("falls back to stripped path for unmatched routes", () => {
    expect(resolveRoutePattern({ url: "/unknown/path?apiKey=123" })).toBe("/unknown/path");
  });
});

describe("request correlation id over HTTP", () => {
  it("returns a generated id when the caller sends none", async () => {
    server = buildTestApp();

    const res = await server.inject({ method: "GET", url: "/healthz" });

    expect(res.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("echoes back a caller-supplied id", async () => {
    server = buildTestApp();

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { [REQUEST_ID_HEADER]: "frontend-trace-7" },
    });

    expect(res.headers[REQUEST_ID_HEADER]).toBe("frontend-trace-7");
  });

  it("does not echo a malformed caller-supplied id", async () => {
    server = buildTestApp();

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { [REQUEST_ID_HEADER]: "not a valid id" },
    });

    expect(res.headers[REQUEST_ID_HEADER]).not.toBe("not a valid id");
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("gives concurrent requests distinct ids", async () => {
    server = buildTestApp();

    const [first, second] = await Promise.all([
      server.inject({ method: "GET", url: "/healthz" }),
      server.inject({ method: "GET", url: "/healthz" }),
    ]);

    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
  });
});

describe("structured access logging over HTTP", () => {
  it("emits exactly one structured log line per request with all required fields", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildTestApp({ logger: { level: "info", stream } });

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { [REQUEST_ID_HEADER]: "trace-log-1" },
    });

    expect(res.statusCode).toBe(200);

    const completed = lines.filter((line) => line.requestId === "trace-log-1");
    expect(completed).toHaveLength(1);
    const log = completed[0]!;

    expect(log).toMatchObject({
      msg: "request completed",
      requestId: "trace-log-1",
      method: "GET",
      url: "/healthz",
      route: "/healthz",
      routePattern: "/healthz",
      statusCode: 200,
      reqId: "trace-log-1",
    });

    expect(log.responseTimeMs).toBeTypeOf("number");
    expect(log.responseTimeMs).toBeGreaterThanOrEqual(0);

    expect(log.responseSize).toBeTypeOf("number");
    expect(log.responseSize).toBe(Buffer.byteLength(res.body));
  });

  it("logs the matched route pattern alongside the concrete URL", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildTestApp({ logger: { level: "info", stream } });

    await server.inject({
      method: "GET",
      url: "/api/markets/42?limit=10",
      headers: { [REQUEST_ID_HEADER]: "param-route-1" },
    });

    const completed = lines.filter((line) => line.requestId === "param-route-1");
    expect(completed).toHaveLength(1);
    const log = completed[0]!;

    expect(log.url).toBe("/api/markets/42?limit=10");
    expect(log.routePattern).toBe("/api/markets/:id");
    expect(log.route).toBe("/api/markets/:id");
  });

  it("redacts sensitive query parameters from the logged url using allowlist", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildTestApp({ logger: { level: "info", stream } });

    await server.inject({
      method: "GET",
      url: "/api/markets/99?limit=10&apiKey=super-secret-key-12345&page=3",
      headers: { [REQUEST_ID_HEADER]: "secret-test-1" },
    });

    const completed = lines.filter((line) => line.requestId === "secret-test-1");
    expect(completed).toHaveLength(1);
    const log = completed[0]!;

    expect(log.url).toBe("/api/markets/99?limit=10&apiKey=[redacted]&page=3");
    expect(JSON.stringify(log)).not.toContain("super-secret-key-12345");
  });

  it("never includes authorization headers or api keys in the access log", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildTestApp({ logger: { level: "info", stream } });

    await server.inject({
      method: "POST",
      url: "/submit",
      headers: {
        [REQUEST_ID_HEADER]: "auth-leak-test",
        authorization: "Bearer secret-bearer-token",
        "x-api-key": "secret-x-api-key",
      },
      payload: { hello: "world" },
    });

    const completed = lines.filter((line) => line.requestId === "auth-leak-test");
    expect(completed).toHaveLength(1);
    const logStr = JSON.stringify(completed[0]);

    expect(logStr).not.toContain("secret-bearer-token");
    expect(logStr).not.toContain("secret-x-api-key");
  });

  it("accurately records 0 response size for 204 No Content responses", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildTestApp({ logger: { level: "info", stream } });

    const res = await server.inject({
      method: "GET",
      url: "/empty-204",
      headers: { [REQUEST_ID_HEADER]: "empty-test-1" },
    });

    expect(res.statusCode).toBe(204);

    const completed = lines.filter((line) => line.requestId === "empty-test-1");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.responseSize).toBe(0);
  });

  it("records unmatched route pattern cleanly for 404 requests", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };

    server = buildTestApp({ logger: { level: "info", stream } });

    const res = await server.inject({
      method: "GET",
      url: "/non-existent-route?apiKey=secret-key-404",
      headers: { [REQUEST_ID_HEADER]: "not-found-1" },
    });

    expect(res.statusCode).toBe(404);

    const completed = lines.filter((line) => line.requestId === "not-found-1");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.url).toBe("/non-existent-route?apiKey=[redacted]");
    expect(completed[0]!.routePattern).toBeDefined();
    expect(JSON.stringify(completed[0])).not.toContain("secret-key-404");
  });
});
