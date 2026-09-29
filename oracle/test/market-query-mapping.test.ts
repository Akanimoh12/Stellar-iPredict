import { describe, expect, it } from "vitest";
import {
  MarketQueryMappingStore,
  validateMarketQueryMapping,
} from "../src/adapters/marketQueryMapping.js";

const BTC_FIXTURE = {
  marketId: "market-btc-2026-01-01",
  asset: "BTC",
  threshold: 100_000,
  comparator: "gte" as const,
  date: "2026-01-01T00:00:00.000Z",
  source: "coinmarketcap",
  query: { symbol: "BTC", convert: "USD" },
};

describe("MarketQueryMappingStore", () => {
  it("stores structured market mappings and returns defensive copies", () => {
    const store = new MarketQueryMappingStore();

    store.set(BTC_FIXTURE);
    const mapping = store.get(BTC_FIXTURE.marketId);

    expect(mapping).toEqual(BTC_FIXTURE);
    expect(mapping).not.toBe(BTC_FIXTURE);
    expect(mapping?.query).not.toBe(BTC_FIXTURE.query);

    if (mapping?.query) {
      mapping.query.symbol = "ETH";
    }
    expect(store.get(BTC_FIXTURE.marketId)?.query?.symbol).toBe("BTC");
  });

  it("updates an existing market without consuming another quota slot", () => {
    const store = new MarketQueryMappingStore({ maxMappings: 1 });

    store.set(BTC_FIXTURE);
    store.set({ ...BTC_FIXTURE, threshold: 101_000 });

    expect(store.size).toBe(1);
    expect(store.get(BTC_FIXTURE.marketId)?.threshold).toBe(101_000);
  });

  it("rejects new mappings after the configured quota", () => {
    const store = new MarketQueryMappingStore({ maxMappings: 1 });
    store.set(BTC_FIXTURE);

    expect(() => store.set({ ...BTC_FIXTURE, marketId: "market-2" })).toThrow(/quota exceeded/);
  });

  it("validates mapping fields before storage", () => {
    expect(() => validateMarketQueryMapping({ marketId: "", threshold: 1 })).toThrow(/marketId/);
    expect(() => validateMarketQueryMapping({ marketId: "market-1", threshold: Number.NaN })).toThrow(/threshold/);
    expect(() =>
      validateMarketQueryMapping({ marketId: "market-1", comparator: "invalid" as "gte" }),
    ).toThrow(/comparator/);
    expect(() => validateMarketQueryMapping({ marketId: "market-1", date: "not-a-date" })).toThrow(/date/);
  });

  it("lists mappings in insertion order and removes them by market id", () => {
    const store = new MarketQueryMappingStore();
    store.set(BTC_FIXTURE);
    store.set({ ...BTC_FIXTURE, marketId: "market-2", asset: "ETH" });

    expect(store.list().map((mapping) => mapping.marketId)).toEqual(["market-btc-2026-01-01", "market-2"]);
    expect(store.delete("market-btc-2026-01-01")).toBe(true);
    expect(store.get("market-btc-2026-01-01")).toBeUndefined();
  });
});
