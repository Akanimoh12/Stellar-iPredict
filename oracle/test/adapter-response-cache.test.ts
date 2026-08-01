import { describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/adapters/binance.js";
import type { Market } from "../src/adapters/index.js";

const market: Market = {
  id: "market-1",
  category: "crypto",
  params: { symbol: "BTCUSDT", comparator: "gte", threshold: 50_000 },
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe("adapter response caching", () => {
  it("reuses a successful response within the TTL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ symbol: "BTCUSDT", price: "52341" }));
    const adapter = new BinanceAdapter({ fetchFn, cacheTtlMs: 60_000 });

    await adapter.fetchOutcome(market);
    await adapter.fetchOutcome({ ...market, id: "same-source-market" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent requests", async () => {
    let resolveResponse: ((response: ReturnType<typeof jsonResponse>) => void) | undefined;
    const response = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchFn = vi.fn().mockReturnValue(response);
    const adapter = new BinanceAdapter({ fetchFn, cacheTtlMs: 60_000 });

    const first = adapter.fetchOutcome(market);
    const second = adapter.fetchOutcome(market);
    resolveResponse?.(jsonResponse({ symbol: "BTCUSDT", price: "52341" }));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed requests", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(jsonResponse({ symbol: "BTCUSDT", price: "52341" }));
    const adapter = new BinanceAdapter({ fetchFn, cacheTtlMs: 60_000, maxRetries: 1 });

    await expect(adapter.fetchOutcome(market)).rejects.toThrow("temporary failure");
    await adapter.fetchOutcome(market);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("can disable caching", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ symbol: "BTCUSDT", price: "52341" }));
    const adapter = new BinanceAdapter({ fetchFn, cacheTtlMs: 0 });

    await adapter.fetchOutcome(market);
    await adapter.fetchOutcome(market);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
