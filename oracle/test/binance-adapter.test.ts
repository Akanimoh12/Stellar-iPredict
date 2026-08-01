import { describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/adapters/binance.js";
import type { Market } from "../src/adapters/index.js";

// Recorded shape of a real `GET /api/v3/ticker/price?symbol=BTCUSDT` response.
const BINANCE_FIXTURE = { symbol: "BTCUSDT", price: "52341.18000000" };

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "crypto",
    params: { symbol: "BTCUSDT", comparator: "gte", threshold: 50_000 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("BinanceAdapter", () => {
  it("supports crypto markets with valid params, not other categories", () => {
    const adapter = new BinanceAdapter();
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "sports" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { symbol: "BTCUSDT" } }))).toBe(false);
  });

  it("maps the market symbol to a ticker query and resolves gte threshold outcomes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(BINANCE_FIXTURE));
    const adapter = new BinanceAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({ outcome: true, confidence: 1, raw: BINANCE_FIXTURE });
  });

  it("resolves lte threshold outcomes as false when price is above threshold", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(BINANCE_FIXTURE));
    const adapter = new BinanceAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "BTCUSDT", comparator: "lte", threshold: 50_000 } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("retries on a 429 rate limit and succeeds on a later attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(BINANCE_FIXTURE));
    const adapter = new BinanceAdapter({ fetchFn, retryBackoffMs: 1 });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe(true);
  });

  it("does not retry a non-retryable 400 and throws immediately", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ msg: "Invalid symbol" }, 400));
    const adapter = new BinanceAdapter({ fetchFn, retryBackoffMs: 1 });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/400/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when the response price is not numeric", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ symbol: "BTCUSDT", price: "N/A" }));
    const adapter = new BinanceAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/non-numeric/);
  });

  it("throws when params are missing/invalid rather than silently resolving", async () => {
    const adapter = new BinanceAdapter();
    await expect(adapter.fetchOutcome(createMarket({ params: {} }))).rejects.toThrow(/missing\/invalid/);
  });
});
