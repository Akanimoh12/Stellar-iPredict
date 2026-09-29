import { describe, expect, it, vi } from "vitest";
import { CoinGeckoAdapter } from "../src/adapters/coingecko.js";
import type { Market } from "../src/adapters/index.js";

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

describe("CoinGeckoAdapter historical lookup", () => {
  it("queries market_chart/range when params.at is present and uses closest price", async () => {
    // create a price array with ms timestamps near the target
    const targetSec = 1_700_000_000; // arbitrary unix seconds
    const baseMs = targetSec * 1000;
    const prices = [
      [baseMs - 40_000, 49000],
      [baseMs - 10_000, 49900],
      [baseMs + 5_000, 50100],
      [baseMs + 50_000, 52000],
    ];

    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ prices }))
      // fallback not expected but safe
      .mockResolvedValueOnce(jsonResponse({ bitcoin: { usd: 52341.18 } }));

    const adapter = new CoinGeckoAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket({ params: { symbol: "bitcoin", comparator: "gte", threshold: 50_000, at: targetSec } }));

    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("market_chart/range"), expect.objectContaining({ method: "GET" }));
    // closest price to target is 50100 -> comparator gte 50000 => true
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1);
  });
});
