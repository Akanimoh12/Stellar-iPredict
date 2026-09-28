import { describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/adapters/binance.js";
import { resetStalenessRegistry, staleAdapterReports } from "../src/adapters/stalenessRegistry.js";
import { resolveFreshnessPolicy } from "../src/adapters/freshness.js";
import type { Market } from "../src/adapters/index.js";

/**
 * Recorded shape of a real `GET /api/v3/ticker/24hr?symbol=BTCUSDT` response,
 * trimmed to the fields the adapter reads.
 */
const BINANCE_FIXTURE = {
  symbol: "BTCUSDT",
  lastPrice: "52341.18000000",
  openTime: 1_735_689_600_000,
  closeTime: 1_735_775_999_999,
};

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

/** A fixture stamped `ageMs` in the past, relative to the frozen clock. */
function fixtureAt(now: number, ageMs: number) {
  return { ...BINANCE_FIXTURE, closeTime: now - ageMs };
}

describe("BinanceAdapter", () => {
  it("supports crypto markets with valid params, not other categories", () => {
    const adapter = new BinanceAdapter();
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "sports" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { symbol: "BTCUSDT" } }))).toBe(false);
  });

  it("queries the 24h ticker, which carries a timestamp, not the bare price endpoint", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 1_000)));
    const adapter = new BinanceAdapter({ fetchFn });

    await adapter.fetchOutcome(createMarket());

    // `/api/v3/ticker/price` returns `{symbol, price}` with no observation
    // time, so freshness would be unverifiable there.
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("resolves a fresh timestamped quote at full confidence", async () => {
    const now = Date.now();
    const body = fixtureAt(now, 1_000);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body));
    const adapter = new BinanceAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.freshness).toEqual({
      status: "fresh",
      ageMs: expect.any(Number),
      observedAtMs: body.closeTime,
      maxAgeMs: resolveFreshnessPolicy().maxAgeMs,
    });
  });

  it("downweights a stale quote instead of resolving it at full confidence", async () => {
    const now = Date.now();
    // 45s old: past the 30s soft bound, inside the 120s hard bound.
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 45_000)));
    const adapter = new BinanceAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeLessThan(1);
    expect(result.confidence).toBe(0.5);
    expect(result.freshness?.status).toBe("stale");
  });

  it("rejects a quote past the hard freshness bound rather than resolving against it", async () => {
    const now = Date.now();
    // 10 minutes old — a cached tape served during an upstream outage.
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 600_000)));
    const adapter = new BinanceAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/freshness bound/);
  });

  it("downweights rather than rejects when the provider sends no timestamp at all", async () => {
    const { closeTime: _dropped, openTime: _alsoDropped, ...untimestamped } = BINANCE_FIXTURE;
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ symbol: "BTCUSDT", lastPrice: "52341.18" }));
    const adapter = new BinanceAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.freshness?.status).toBe("untimestamped");
    expect(result.freshness?.ageMs).toBeNull();
    expect(untimestamped).toBeDefined();
  });

  it("applies a per-adapter freshness bound from configuration", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 45_000)));

    // 45s is stale under the default 30s soft bound, but comfortably inside a
    // 120s soft bound — proof the bound is configurable and not hard-coded.
    const strict = new BinanceAdapter({ fetchFn });
    expect((await strict.fetchOutcome(createMarket())).confidence).toBe(0.5);

    const relaxed = new BinanceAdapter({
      fetchFn,
      freshness: { maxAgeMs: 600_000, staleAfterMs: 120_000 },
    });
    const relaxedResult = await relaxed.fetchOutcome(createMarket({ id: "market-2" }));
    expect(relaxedResult.confidence).toBe(1);
    expect(relaxedResult.freshness?.status).toBe("fresh");
  });

  it("reads its freshness bound from the environment under an adapter-specific prefix", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 45_000)));
    const adapter = new BinanceAdapter({
      fetchFn,
      env: {
        ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS: "600000",
        ORACLE_BINANCE_FRESHNESS_STALE_AFTER_MS: "120000",
        // A different adapter's variable must not leak into this one.
        ORACLE_COINGECKO_FRESHNESS_MAX_AGE_MS: "1000",
      },
    });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.confidence).toBe(1);
  });

  it("records every quote's status so sustained staleness can be alerted on", async () => {
    const now = Date.now();
    resetStalenessRegistry({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });

    const staleAdapter = new BinanceAdapter({ fetchFn: vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 45_000))) });
    // Distinct symbols, so the adapter's response cache does not serve the
    // second call from the first one's entry and skip the loader entirely.
    await staleAdapter.fetchOutcome(
      createMarket({ id: "m1", params: { symbol: "BTCUSDT", comparator: "gte", threshold: 50_000 } }),
    );
    await staleAdapter.fetchOutcome(
      createMarket({ id: "m2", params: { symbol: "ETHUSDT", comparator: "gte", threshold: 3_000 } }),
    );

    const reports = staleAdapterReports(Date.now());
    expect(reports.map((r) => r.adapterId)).toContain("binance");
    expect(reports[0]!.worstStatus).toBe("stale");
  });

  it("resolves lte threshold outcomes as false when price is above threshold", async () => {
    const now = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(fixtureAt(now, 1_000)));
    const adapter = new BinanceAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { symbol: "BTCUSDT", comparator: "lte", threshold: 50_000 } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("retries on a 429 rate limit and succeeds on a later attempt", async () => {
    const now = Date.now();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(fixtureAt(now, 1_000)));
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
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ symbol: "BTCUSDT", lastPrice: "N/A" }));
    const adapter = new BinanceAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/non-numeric/);
  });

  it("throws when params are missing/invalid rather than silently resolving", async () => {
    const adapter = new BinanceAdapter();
    await expect(adapter.fetchOutcome(createMarket({ params: {} }))).rejects.toThrow(/missing\/invalid/);
  });
});
