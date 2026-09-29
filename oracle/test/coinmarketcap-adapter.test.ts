import { describe, expect, it, vi } from "vitest";
import { CoinMarketCapAdapter } from "../src/adapters/coinmarketcap.js";
import { resolveFreshnessPolicy } from "../src/adapters/freshness.js";
import type { Market } from "../src/adapters/index.js";

/** Recorded shape of a real `GET /v2/cryptocurrency/quotes/latest?symbol=BTC` response (trimmed). */
const CMC_FIXTURE = {
  data: {
    BTC: [
      {
        quote: {
          USD: {
            price: 52341.18,
            last_updated_timestamp: 1_735_775_999,
            last_updated: "2025-01-15T23:59:59.000Z",
          },
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

/** The fixture re-stamped `ageMs` in the past, relative to the frozen clock. */
function fixtureAt(now: number, ageMs: number) {
  const observedAt = now - ageMs;
  return {
    data: {
      BTC: [
        {
          quote: {
            USD: {
              price: 52341.18,
              last_updated_timestamp: Math.floor(observedAt / 1000),
              last_updated: new Date(observedAt).toISOString(),
            },
          },
        },
      ],
    },
  };
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
    const now = Date.now();
    const body = fixtureAt(now, 1_000);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=BTC&convert=USD",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-CMC_PRO_API_KEY": "test-key" }),
      }),
    );
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.raw).toBe(body);
  });

  it("reads the provider's own timestamp rather than assuming the request time", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 2_000)));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.freshness).toEqual({
      status: "fresh",
      ageMs: expect.any(Number),
      observedAtMs: expect.any(Number),
      maxAgeMs: resolveFreshnessPolicy().maxAgeMs,
    });
  });

  it("downweights a stale quote rather than resolving it at full confidence", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 45_000)));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.freshness?.status).toBe("stale");
  });

  it("rejects a quote past the hard freshness bound", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 600_000)));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/freshness bound/);
  });

  it("downweights a quote the provider sent without a timestamp", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ data: { BTC: [{ quote: { USD: { price: 52341.18 } } }] } }),
    );
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.confidence).toBe(0.5);
    expect(result.freshness?.status).toBe("untimestamped");
  });

  it("applies a per-adapter freshness bound from configuration", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 45_000)));
    const adapter = new CoinMarketCapAdapter({
      apiKey: "test-key",
      fetchFn,
      env: {
        ORACLE_COINMARKETCAP_FRESHNESS_MAX_AGE_MS: "600000",
        ORACLE_COINMARKETCAP_FRESHNESS_STALE_AFTER_MS: "120000",
        ORACLE_BINANCE_FRESHNESS_STALE_AFTER_MS: "1000",
      },
    });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.confidence).toBe(1);
  });

  it("resolves lte threshold outcomes as false when price is above threshold", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 1_000)));
    const adapter = new CoinMarketCapAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "BTC", comparator: "lte", threshold: 50_000 } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("retries on a 5xx error and succeeds on a later attempt", async () => {
    const now = Date.now();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(fixtureAt(now, 1_000)));
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
