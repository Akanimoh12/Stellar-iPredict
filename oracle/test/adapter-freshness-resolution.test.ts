/**
 * Freshness as a *resolution* property (issue #744).
 *
 * The adapter-level tests prove the price adapter downweights or rejects a
 * stale quote. These prove the consequence that actually matters: a market
 * resolved against a stale or unverifiable quote does not come out the other
 * side as a confident resolution, and an expired one falls through to the
 * next source rather than settling on a cached tape.
 */
import { describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/adapters/binance.js";
import { CoinMarketCapAdapter } from "../src/adapters/coinmarketcap.js";
import { InMemoryReviewQueue, type DataAdapter, type Market } from "../src/adapters/index.js";
import { resolveMarket } from "../src/adapters/resolve.js";

const CATEGORY_MIN_CONFIDENCE = 0.7; // DEFAULT_CATEGORY_CONFIG.crypto.minConfidence

function market(overrides: Partial<Market> = {}): Market {
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

function binanceTicker(ageMs: number) {
  return { symbol: "BTCUSDT", lastPrice: "52341.18", closeTime: Date.now() - ageMs };
}

function cmcQuote(ageMs: number) {
  return {
    data: { BTC: [{ quote: { USD: { price: 52341.18, last_updated_timestamp: Date.now() - ageMs } } }] },
  };
}

describe("stale quotes do not resolve markets at full confidence", () => {
  it("holds a market for review when the only source is stale", async () => {
    const adapter = new BinanceAdapter({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(binanceTicker(45_000))),
    });
    const reviewQueue = new InMemoryReviewQueue();

    const result = await resolveMarket(market(), [adapter], { reviewQueue });

    expect(result.sources[0]!.confidence).toBeLessThan(CATEGORY_MIN_CONFIDENCE);
    expect(result.confidence).toBeLessThan(CATEGORY_MIN_CONFIDENCE);
    expect(result.status).toBe("review");
    expect(result.outcome).toBeUndefined();
    expect(reviewQueue.list()).toHaveLength(1);
    expect(reviewQueue.list()[0]!.reason).toBe("low_confidence");
  });

  it("holds a market for review when the only source supplies no timestamp", async () => {
    const adapter = new CoinMarketCapAdapter({
      apiKey: "test-key",
      fetchFn: vi.fn().mockResolvedValue(
        jsonResponse({ data: { BTC: [{ quote: { USD: { price: 52341.18 } } }] } }),
      ),
    });
    const reviewQueue = new InMemoryReviewQueue();

    const result = await resolveMarket(
      market({ params: { symbol: "BTC", comparator: "gte", threshold: 50_000 } }),
      [adapter],
      { reviewQueue },
    );

    expect(result.status).toBe("review");
    expect(result.confidence).toBeLessThan(CATEGORY_MIN_CONFIDENCE);
    expect(reviewQueue.list()).toHaveLength(1);
  });

  it("resolves normally when the quote is fresh", async () => {
    const adapter = new BinanceAdapter({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(binanceTicker(1_000))),
    });
    const reviewQueue = new InMemoryReviewQueue();

    const result = await resolveMarket(market(), [adapter], { reviewQueue });

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1);
    expect(reviewQueue.list()).toHaveLength(0);
  });

  it("falls through to the next source when the primary is past the hard bound", async () => {
    const primary = new BinanceAdapter({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(binanceTicker(600_000))),
    });
    // Different symbol so the fallback is not served from a cache entry.
    const fallback: DataAdapter = {
      id: "fallback",
      supports: () => true,
      fetchOutcome: vi.fn().mockResolvedValue({ outcome: true, confidence: 1, raw: { price: 52341.18 } }),
    };

    const result = await resolveMarket(market(), [primary, fallback], {
      reviewQueue: new InMemoryReviewQueue(),
    });

    expect(result.status).toBe("resolved");
    expect(result.sources[0]!.adapterId).toBe("binance");
    expect(result.sources[0]!.error).toMatch(/freshness bound/);
    expect(result.sources[1]!.adapterId).toBe("fallback");
    expect(result.confidence).toBe(1);
  });

  it("records the quote's age on the resolution for later dispute review", async () => {
    const adapter = new BinanceAdapter({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(binanceTicker(45_000))),
    });

    const result = await resolveMarket(market(), [adapter], {
      reviewQueue: new InMemoryReviewQueue(),
    });

    // `raw` survives onto the source result, so an audit can see the provider
    // payload; the structured verdict is what the freshness field carries.
    expect(result.sources[0]!.raw).toMatchObject({ closeTime: expect.any(Number) });
  });
});
