import { describe, expect, it, vi } from "vitest";
import { CoinMarketCapAdapter } from "../src/adapters/coinmarketcap.js";
import type { Market } from "../src/adapters/index.js";

// Recorded shape of a real `GET /v2/cryptocurrency/quotes/latest?symbol=BTC` response (trimmed).
const CMC_FIXTURE = {
  data: {
    BTC: [
      {
        quote: {
          USD: { price: 52341.18 },
        },
      },
    ],
  },
};

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "crypto",
    params: { symbol: "BTC", comparator: "gte", threshold: 50_000 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("CoinMarketCapAdapter", () => {
  it("requires an apiKey to construct", () => {
    expect(() => new CoinMarketCapAdapter({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("supports crypto markets with valid params, not other categories", () => {
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key" });
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "politics" }))).toBe(false);
  });

  it("maps the market symbol to a quotes query with the API key header and resolves gte outcomes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(CMC_FIXTURE));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=BTC&convert=USD",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-CMC_PRO_API_KEY": "test-key" }),
      }),
    );
    expect(result).toEqual({ outcome: true, confidence: 1, raw: CMC_FIXTURE });
  });

  it("resolves lte threshold outcomes as false when price is above threshold", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(CMC_FIXTURE));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "BTC", comparator: "lte", threshold: 50_000 } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("retries on a 5xx error and succeeds on a later attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(CMC_FIXTURE));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn, retryBackoffMs: 1 });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe(true);
  });

  it("does not retry a 401 auth failure and throws immediately", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ msg: "Invalid API key" }, 401));
    const adapter = new CoinMarketCapAdapter({ apiKey: "bad-key", fetchFn, retryBackoffMs: 1 });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when the symbol is missing from the response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/no usable USD price/);
  });
});
