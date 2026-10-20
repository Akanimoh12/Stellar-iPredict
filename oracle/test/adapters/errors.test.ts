import { describe, expect, it, vi } from "vitest";
import { classifySourceError, classifySourceResponse } from "../../src/adapters/errors.js";
import {
  fetchSourceJson,
  isRetryableAdapterError,
  retryAfterFromHeaders,
  retryDelayMs,
} from "../../src/adapters/http.js";
import { logAdapterError } from "../../src/adapters/logging.js";

describe("adapter error taxonomy", () => {
  it.each([
    [401, "auth"],
    [429, "quota"],
    [503, "network"],
    [422, "data"],
  ] as const)("classifies HTTP %i as %s", (status, kind) => {
    const error = classifySourceResponse("fixture-source", { status, headers: new Headers() });
    expect(error?.kind).toBe(kind);
  });

  it("uses Retry-After for quota failures and does not retry them", () => {
    const error = classifySourceResponse("fixture-source", {
      status: 429,
      headers: new Headers({ "retry-after": "45" }),
    });
    expect(error?.retryAfterMs).toBe(45_000);
    expect(isRetryableAdapterError(error)).toBe(false);
  });

  it("prefers a provider Retry-After over the fallback delay", () => {
    const error = classifySourceResponse("fixture-source", {
      status: 429,
      headers: new Headers({ "retry-after": "2" }),
    });
    expect(retryDelayMs(error, 500)).toBe(2_000);
    expect(retryDelayMs(new Error("no hint"), 500)).toBe(500);
    expect(retryDelayMs(undefined, 500)).toBe(500);
  });

  it("reads Retry-After as delta-seconds or an HTTP date", () => {
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "1.5" }))).toBe(1_500);
    const inFuture = new Date(Date.now() + 60_000).toUTCString();
    expect(retryAfterFromHeaders(new Headers({ "retry-after": inFuture }))).toBeGreaterThan(50_000);
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterFromHeaders(new Headers())).toBeUndefined();
    expect(retryAfterFromHeaders(undefined)).toBeUndefined();
  });

  it("classifies malformed provider JSON as data", () => {
    expect(classifySourceError("fixture-source", new SyntaxError("Unexpected token"))).toMatchObject({
      kind: "data",
      retryable: false,
    });
  });

  it("makes exactly one request when a source is quota limited", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSourceJson("https://example.test/prices", { source: "fixture-source" }))
      .rejects.toMatchObject({ kind: "quota" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("logs safe structured metadata rather than upstream messages", () => {
    const logger = { error: vi.fn() };
    logAdapterError("fixture-source", new Error("token=do-not-log"), logger);
    expect(logger.error).toHaveBeenCalledWith("oracle.adapter.error", expect.objectContaining({
      source: "fixture-source",
      category: "network",
    }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("token=do-not-log");
  });
});
