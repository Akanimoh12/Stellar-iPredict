import { describe, expect, it, vi } from "vitest";
import { AdapterHttpError, fetchWithRetry } from "../src/adapters/httpRetry.js";

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
