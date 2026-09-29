import { describe, expect, it, vi } from "vitest";
import { badRequest, errorHandler, notFound } from "../backend/src/lib/errors.js";
import { REQUEST_ID_HEADER } from "../backend/src/lib/log.js";

function replyMock() {
  return {
    statusCode: 0,
    payload: undefined as unknown,
    headers: {} as Record<string, string>,
    status: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    header: vi.fn(function (this: { headers: Record<string, string> }, key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
      return this;
    }),
    send: vi.fn(function (this: { payload: unknown }, payload: unknown) { this.payload = payload; return this; }),
  };
}

describe("central Fastify error handler", () => {
  it("returns known 4xx errors in a stable shape", () => {
    const reply = replyMock();
    errorHandler(notFound("Market not found") as never, { id: "req-1" } as never, reply as never);
    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({
      error: { code: "NOT_FOUND", message: "Market not found", requestId: "req-1" },
    });
  });

  it("hides internals and stack traces for 500s", () => {
    const reply = replyMock();
    errorHandler(new Error("database password leaked") as never, { id: "req-1" } as never, reply as never);
    expect(reply.statusCode).toBe(500);
    expect(reply.payload).toEqual({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error", requestId: "req-1" },
    });
    expect(JSON.stringify(reply.payload)).not.toContain("stack");
    expect(JSON.stringify(reply.payload)).not.toContain("database password leaked");
  });

  it("maps explicit bad requests", () => {
    const reply = replyMock();
    errorHandler(badRequest("Invalid page") as never, { id: "req-1" } as never, reply as never);
    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({
      error: { code: "BAD_REQUEST", message: "Invalid page", requestId: "req-1" },
    });
  });

  it("stamps the request id so a report can be traced back to a log line", () => {
    const reply = replyMock();
    errorHandler(notFound("Market not found") as never, { id: "req-42" } as never, reply as never);
    expect(reply.headers[REQUEST_ID_HEADER]).toBe("req-42");
  });
});
