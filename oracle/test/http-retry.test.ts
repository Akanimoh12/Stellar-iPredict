import { describe, expect, it, vi } from "vitest";
import {
  AdapterHttpError,
  AdapterTimeoutError,
  defaultTotalTimeoutMs,
  fetchWithRetry,
} from "../src/adapters/httpRetry.js";

function jsonResponse(status: number) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
}

describe("fetchWithRetry", () => {
  it("returns the response on the first successful attempt", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200));
    const response = await fetchWithRetry("https://example.test", {}, { fetchFn });
    expect(response.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws the last error on persistent failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(503));

    await expect(
      fetchWithRetry("https://example.test", {}, { fetchFn, maxRetries: 3, retryBackoffMs: 1 }),
    ).rejects.toThrow(AdapterHttpError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries on a thrown network error and eventually succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200));

    const response = await fetchWithRetry("https://example.test", {}, { fetchFn, retryBackoffMs: 1 });
    expect(response.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable 4xx status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(404));

    await expect(
      fetchWithRetry("https://example.test", {}, { fetchFn, retryBackoffMs: 1 }),
    ).rejects.toThrow(/404/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry timeouts", () => {
  /** A provider that accepts the connection and never answers, honouring abort. */
  function hangingFetch() {
    return vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
  }

  it("times out a non-responding provider at the configured limit", async () => {
    const fetchFn = hangingFetch();
    const started = Date.now();

    await expect(
      fetchWithRetry("https://example.test", {}, { fetchFn, timeoutMs: 30, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(AdapterTimeoutError);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it("times out even when the fetch implementation ignores its abort signal", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.test", {}, { fetchFn, timeoutMs: 20, maxRetries: 1 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("retries after a timeout instead of hanging, and succeeds on a later attempt", async () => {
    const hang = hangingFetch();
    let calls = 0;
    const fetchFn = vi.fn((url: unknown, init?: RequestInit) => {
      calls += 1;
      return calls === 1 ? (hang as any)(url, init) : Promise.resolve(jsonResponse(200));
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "https://example.test",
      {},
      { fetchFn, timeoutMs: 20, maxRetries: 3, retryBackoffMs: 1 },
    );

    expect(response.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("bounds total time across all retry attempts", async () => {
    const fetchFn = hangingFetch();
    const started = Date.now();

    await expect(
      fetchWithRetry(
        "https://example.test",
        {},
        { fetchFn, timeoutMs: 40, maxRetries: 10, retryBackoffMs: 5, totalTimeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ name: "AdapterTimeoutError", scope: "total" });

    expect(Date.now() - started).toBeLessThan(400);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(10);
  });

  it("derives a default total budget from attempts and backoff", () => {
    expect(defaultTotalTimeoutMs(1000, 3, 100)).toBe(3000 + 100 + 200);
    expect(defaultTotalTimeoutMs(1000, 1, 100)).toBe(1000);
  });

  it("times out a provider that sends headers and then stalls the body", async () => {
    const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const fetchFn = vi.fn().mockResolvedValue(stalled) as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.test", {}, { fetchFn, timeoutMs: 20, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(AdapterTimeoutError);
  });
});
