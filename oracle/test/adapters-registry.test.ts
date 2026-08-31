import { describe, expect, it } from "vitest";
import { AdapterRegistry, type AdapterOutcome, type DataAdapter, type Market } from "../src/adapters/index.js";

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "crypto",
    params: { symbol: "BTCUSDT", comparator: "gte", threshold: 50_000 },
    ...overrides,
  };
}

function createStubAdapter(id: string, supportsCategory: Market["category"]): DataAdapter {
  return {
    id,
    supports: (market) => market.category === supportsCategory,
    fetchOutcome: async (): Promise<AdapterOutcome> => ({ outcome: true, confidence: 1, raw: {} }),
  };
}

describe("AdapterRegistry", () => {
  it("returns adapters that support a market's category, in registration order", () => {
    const registry = new AdapterRegistry();
    const binance = createStubAdapter("binance", "crypto");
    const cmc = createStubAdapter("coinmarketcap", "crypto");
    const sports = createStubAdapter("sportdata", "sports");

    registry.register(binance);
    registry.register(cmc);
    registry.register(sports);

    const result = registry.adaptersFor(createMarket());
    expect(result.map((a) => a.id)).toEqual(["binance", "coinmarketcap"]);
  });

  it("returns an empty list when no adapter supports the market", () => {
    const registry = new AdapterRegistry();
    registry.register(createStubAdapter("sportdata", "sports"));

    expect(registry.adaptersFor(createMarket({ category: "crypto" }))).toEqual([]);
  });

  it("looks up a registered adapter by id", () => {
    const registry = new AdapterRegistry();
    const binance = createStubAdapter("binance", "crypto");
    registry.register(binance);

    expect(registry.getById("binance")).toBe(binance);
    expect(registry.getById("missing")).toBeUndefined();
  });

  it("lists all registered adapters", () => {
    const registry = new AdapterRegistry();
    const binance = createStubAdapter("binance", "crypto");
    const cmc = createStubAdapter("coinmarketcap", "crypto");
    registry.register(binance);
    registry.register(cmc);

    expect(registry.list()).toEqual([binance, cmc]);
  });

  it("prioritizes adapters matching market metadata tags", () => {
    const registry = new AdapterRegistry();
    const binance = createStubAdapter("binance", "crypto");
    const cmc = { ...createStubAdapter("coinmarketcap", "crypto"), tags: ["cmc-custom"] };
    registry.register(binance);
    registry.register(cmc);

    const marketWithIdTag = createMarket({ tags: ["coinmarketcap"] });
    expect(registry.adaptersFor(marketWithIdTag).map((a) => a.id)).toEqual(["coinmarketcap", "binance"]);

    const marketWithCustomTag = createMarket({ tags: ["cmc-custom"] });
    expect(registry.adaptersFor(marketWithCustomTag).map((a) => a.id)).toEqual(["coinmarketcap", "binance"]);
  });
});
