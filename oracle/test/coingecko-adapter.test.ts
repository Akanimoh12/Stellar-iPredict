import { describe, expect, it, vi } from "vitest";
import { CoinGeckoAdapter } from "../src/adapters/coingecko.js";
import type { Market } from "../src/adapters/index.js";

// Recorded shape of a real CoinGecko price API response.
const COINGECKO_FIXTURE = {
  bitcoin: {
    usd: 52341.18,
    usd_market_cap: 1023456789012,
    usd_24h_vol: 25000000000,
  },
};

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "crypto",
    params: { symbol: "bitcoin", comparator: "gte", threshold: 50_000 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("CoinGeckoAdapter", () => {
  it("supports crypto markets with valid params, not other categories", () => {
    const adapter = new CoinGeckoAdapter();
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "politics" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { symbol: "bitcoin" } }))).toBe(false);
  });

  it("maps the market symbol to a price query and resolves gte threshold outcomes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(COINGECKO_FIXTURE));
    const adapter = new CoinGeckoAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("api.coingecko.com/api/v3/simple/price"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({ outcome: true, confidence: 1, raw: COINGECKO_FIXTURE });
  });

  it("resolves lte threshold outcomes as false when price is above threshold", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(COINGECKO_FIXTURE));
    const adapter = new CoinGeckoAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "bitcoin", comparator: "lte", threshold: 50_000 } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("uses market cap instead of price when useMarketCap option is true", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(COINGECKO_FIXTURE));
    const adapter = new CoinGeckoAdapter({ fetchFn, useMarketCap: true });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "bitcoin", comparator: "gte", threshold: 1_000_000_000_000 } }),
    );

    expect(result.outcome).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("include_market_cap=true"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("includes API key header when provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(COINGECKO_FIXTURE));
    const adapter = new CoinGeckoAdapter({ fetchFn, apiKey: "test-key" });

    await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-cg-demo-api-key": "test-key" }),
      }),
    );
  });

  it("retries on a 429 rate limit and succeeds on a later attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(COINGECKO_FIXTURE));
    const adapter = new CoinGeckoAdapter({ fetchFn, retryBackoffMs: 1 });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe(true);
  });

  it("does not retry a non-retryable 400 and throws immediately", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "Invalid coin id" }, 400));
    const adapter = new CoinGeckoAdapter({ fetchFn, retryBackoffMs: 1 });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/400/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when the response price is not numeric", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: { usd: "N/A" } }));
    const adapter = new CoinGeckoAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/invalid price/);
  });

  it("throws when the symbol is missing from the response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}));
    const adapter = new CoinGeckoAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/no data for symbol/);
  });

  it("throws when params are missing/invalid rather than silently resolving", async () => {
    const adapter = new CoinGeckoAdapter();
    await expect(adapter.fetchOutcome(createMarket({ params: {} }))).rejects.toThrow(/missing\/invalid/);
  });
});
