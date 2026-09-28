import { describe, expect, it, vi } from "vitest";
import { CoinGeckoAdapter } from "../src/adapters/coingecko.js";
import type { Market } from "../src/adapters/index.js";

/**
 * A real CoinGecko price response, stamped `ageMs` in the past.
 *
 * Stamped relative to a clock the caller passes rather than to a fixed date,
 * because a fixed `last_updated_at` would be years stale by the time anyone
 * runs this and the adapter would (correctly) reject it.
 */
function coingeckoFixtureAt(now: number, ageMs: number) {
  return {
    bitcoin: {
      usd: 52341.18,
      usd_market_cap: 1023456789012,
      usd_24h_vol: 25000000000,
      last_updated_at: Math.floor((now - ageMs) / 1000),
    },
  };
}

/** A response with the timestamp omitted entirely — freshness unverifiable. */
const UNTAMPERED_COINGECKO_FIXTURE = {
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

/** A quote the provider stamped 1s ago — comfortably fresh. */
function fresh() {
  return coingeckoFixtureAt(Date.now(), 1_000);
}

describe("CoinGeckoAdapter", () => {
  it("supports crypto markets with valid params, not other categories", () => {
    const adapter = new CoinGeckoAdapter();
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "politics" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { symbol: "bitcoin" } }))).toBe(false);
  });

  it("maps the market symbol to a price query and resolves gte threshold outcomes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fresh()));
    const adapter = new CoinGeckoAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("api.coingecko.com/api/v3/simple/price"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toMatchObject({ outcome: true, confidence: 1, raw: fresh() });
    expect(result.freshness?.status).toBe("fresh");
  });

  it("resolves lte threshold outcomes as false when price is above threshold", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fresh()));
    const adapter = new CoinGeckoAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "bitcoin", comparator: "lte", threshold: 50_000 } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("uses market cap instead of price when useMarketCap option is true", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fresh()));
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
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fresh()));
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
      .mockResolvedValueOnce(jsonResponse(fresh()));
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

  describe("freshness", () => {
    it("downweights a stale live quote", async () => {
      const now = Date.now();
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(coingeckoFixtureAt(now, 45_000)));
      const adapter = new CoinGeckoAdapter({ fetchFn });

      const result = await adapter.fetchOutcome(createMarket());

      expect(result.confidence).toBe(0.5);
      expect(result.freshness?.status).toBe("stale");
    });

    it("rejects a live quote past the hard bound", async () => {
      const now = Date.now();
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(coingeckoFixtureAt(now, 600_000)));
      const adapter = new CoinGeckoAdapter({ fetchFn });

      await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/freshness bound/);
    });

    it("downweights a live quote the provider sent without a timestamp", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(UNTAMPERED_COINGECKO_FIXTURE));
      const adapter = new CoinGeckoAdapter({ fetchFn });

      const result = await adapter.fetchOutcome(createMarket());

      expect(result.confidence).toBe(0.5);
      expect(result.freshness?.status).toBe("untimestamped");
    });

    it("judges a historical quote against the requested instant, not the wall clock", async () => {
      // A market resolving on last Tuesday's close is *supposed* to see
      // last Tuesday's price. Judged against `Date.now()` it would be stale by
      // construction, so the reference instant is the one the market asked for.
      const at = 1_700_000_000;
      const atMs = at * 1000;
      const prices = [
        [atMs - 10_000, 49_900],
        [atMs + 5_000, 50_100],
      ];
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ prices }));
      const adapter = new CoinGeckoAdapter({ fetchFn });

      const result = await adapter.fetchOutcome(
        createMarket({ params: { symbol: "bitcoin", comparator: "gte", threshold: 50_000, at } }),
      );

      expect(result.outcome).toBe(true);
      expect(result.confidence).toBe(1);
      // Age is measured one-sided (reference - observation, floored at zero),
      // so a point a few seconds *after* the requested instant is treated as
      // on-time rather than negative.
      expect(result.freshness).toEqual({
        status: "fresh",
        ageMs: 0,
        observedAtMs: atMs + 5_000,
        maxAgeMs: expect.any(Number),
      });
    });

    it("downweights a historical quote that predates the requested window", async () => {
      const at = 1_700_000_000;
      const atMs = at * 1000;
      // Nothing near `at` — the provider is missing data for that window.
      const prices = [[atMs - 45_000, 49_900]];
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ prices }));
      const adapter = new CoinGeckoAdapter({ fetchFn });

      const result = await adapter.fetchOutcome(
        createMarket({ params: { symbol: "bitcoin", comparator: "gte", threshold: 50_000, at } }),
      );

      expect(result.freshness?.status).toBe("stale");
      expect(result.freshness?.ageMs).toBe(45_000);
      expect(result.confidence).toBeLessThan(1);
    });

    it("rejects a historical quote far outside the requested window", async () => {
      const at = 1_700_000_000;
      const atMs = at * 1000;
      const prices = [[atMs - 600_000, 49_900]];
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ prices }));
      const adapter = new CoinGeckoAdapter({ fetchFn });

      await expect(
        adapter.fetchOutcome(
          createMarket({ params: { symbol: "bitcoin", comparator: "gte", threshold: 50_000, at } }),
        ),
      ).rejects.toThrow(/freshness bound/);
    });

    it("applies a per-adapter freshness bound from configuration", async () => {
      const now = Date.now();
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse(coingeckoFixtureAt(now, 45_000)));
      const adapter = new CoinGeckoAdapter({
        fetchFn,
        env: {
          ORACLE_COINGECKO_FRESHNESS_MAX_AGE_MS: "600000",
          ORACLE_COINGECKO_FRESHNESS_STALE_AFTER_MS: "120000",
        },
      });

      expect((await adapter.fetchOutcome(createMarket())).confidence).toBe(1);
    });
  });
});
