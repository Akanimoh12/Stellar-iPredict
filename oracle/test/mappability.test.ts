/**
 * Market mappability (issue #745).
 *
 * The failure this module prevents: a market whose question no adapter can
 * map is created happily, holds stakes for months, and is discovered to be
 * unresolvable when it expires — at which point the only available action is
 * manual intervention under time pressure. These tests pin the three things
 * that make that impossible: detection at creation, a sweep that catches what
 * slipped through, and a way to add a mapping without a redeploy.
 */

import { describe, expect, it } from "vitest";
import {
  assertMarketMappable,
  collectUnmappableMarkets,
  DEFAULT_MAPPABLE_SYMBOLS,
  MappabilityOverrides,
  MarketMappabilityRegistry,
  UnmappableMarketError,
  validateMarketMappability,
  type MappabilityOverride,
  type SweepableMarket,
} from "../src/adapters/mappability.js";
import type { DataAdapter, Market } from "../src/adapters/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function cryptoMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "crypto",
    params: { symbol: "BTCUSDT", comparator: "gte", threshold: 100_000 },
    ...overrides,
  };
}

/** An adapter that claims a market only for a specific symbol. */
function symbolAdapter(id: string, known: readonly string[]): DataAdapter {
  const set = new Set(known.map((s) => s.toUpperCase()));
  return {
    id,
    supports: (market) =>
      market.category === "crypto" &&
      typeof market.params.symbol === "string" &&
      set.has(market.params.symbol.toUpperCase()),
    fetchOutcome: async () => ({ outcome: true, confidence: 1, raw: {} }),
  };
}

const registry = (ids: readonly string[] = ["binance", "coinmarketcap", "coingecko"]) =>
  new MarketMappabilityRegistry(ids);

// ─────────────────────────────────────────────────────────────────────────────
// The unmappable case
// ─────────────────────────────────────────────────────────────────────────────

describe("validateMarketMappability", () => {
  it("accepts a market a configured adapter can query", () => {
    const verdict = validateMarketMappability(cryptoMarket(), { registry: registry() });

    expect(verdict.mappable).toBe(true);
    expect(verdict.reason).toBeUndefined();
    expect(verdict.remedy).toBeUndefined();
  });

  it("rejects a market whose symbol no provider lists", () => {
    const verdict = validateMarketMappability(
      cryptoMarket({ params: { symbol: "NOTACOINUSDT", comparator: "gte", threshold: 1 } }),
      { registry: registry() },
    );

    expect(verdict.mappable).toBe(false);
    expect(verdict.reason).toBe("unknown-symbol");
    expect(verdict.offendingValue).toBe("NOTACOINUSDT");
    // An unmappable verdict with no next step is the situation this exists to
    // end, so the remedy is not optional.
    expect(verdict.remedy).toMatch(/MARKET_MAPPABILITY_OVERRIDES/);
  });

  it("rejects a market in a category no adapter serves", () => {
    const verdict = validateMarketMappability(
      { id: "m", category: "entertainment" as Market["category"], params: {} },
      { registry: registry() },
    );

    expect(verdict.mappable).toBe(false);
    expect(verdict.reason).toBe("unsupported-category");
    expect(verdict.remedy).toMatch(/categories|crypto/);
  });

  it("rejects a crypto market missing the params any adapter needs to build a query", () => {
    for (const params of [
      { comparator: "gte", threshold: 1 },
      { symbol: "BTCUSDT", threshold: 1 },
      { symbol: "BTCUSDT", comparator: "gte" },
      { symbol: "BTCUSDT", comparator: "gte", threshold: "not a number" },
      {},
    ]) {
      const verdict = validateMarketMappability(
        cryptoMarket({ params: params as Record<string, unknown> }),
        { registry: registry() },
      );
      expect(verdict.mappable, JSON.stringify(params)).toBe(false);
      expect(verdict.reason, JSON.stringify(params)).toBe("missing-params");
    }
  });

  it("refuses to guess when it has nothing to check against", () => {
    const verdict = validateMarketMappability(cryptoMarket());

    expect(verdict.mappable).toBe(false);
    expect(verdict.detail).toMatch(/could not be determined/);
  });

  it("defers to a live adapter set when one is supplied", () => {
    const adapters = [symbolAdapter("tiny-exchange", ["WEIRDCOIN"])];

    // The registry knows BTCUSDT; the adapter does not. The adapter is the
    // authority, because it is what resolution will actually query.
    const verdict = validateMarketMappability(cryptoMarket(), {
      adapters,
      registry: registry(["tiny-exchange"]),
    });

    expect(verdict.mappable).toBe(false);
  });

  it("accepts a market a live adapter claims even if the registry is stricter", () => {
    const adapters = [symbolAdapter("tiny-exchange", ["BTCUSDT"])];

    const verdict = validateMarketMappability(cryptoMarket(), {
      adapters,
      // An empty symbol list: the registry alone would reject this.
      registry: new MarketMappabilityRegistry(["tiny-exchange"], { symbols: {} }),
    });

    expect(verdict.mappable).toBe(true);
    expect(verdict.supportedAdapters).toEqual(["tiny-exchange"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Creation time
// ─────────────────────────────────────────────────────────────────────────────

describe("assertMarketMappable", () => {
  it("returns the verdict for a mappable market rather than throwing", () => {
    const verdict = assertMarketMappable(cryptoMarket(), { registry: registry() });
    expect(verdict.mappable).toBe(true);
  });

  it("throws at creation time for an unmappable market, with the remedy attached", () => {
    expect(() =>
      assertMarketMappable(
        cryptoMarket({ params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 } }),
        { registry: registry() },
      ),
    ).toThrow(UnmappableMarketError);

    try {
      assertMarketMappable(
        cryptoMarket({ id: "m-42", params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 } }),
        { registry: registry() },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const unmappable = error as UnmappableMarketError;
      // The market id is in the message so a rejection is traceable to a
      // specific creation attempt.
      expect(unmappable.marketId).toBe("m-42");
      expect(unmappable.reason).toBe("unknown-symbol");
      expect(unmappable.message).toContain("NOPEUSDT");
      expect(unmappable.message).toMatch(/MARKET_MAPPABILITY_OVERRIDES/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overrides, without a redeploy
// ─────────────────────────────────────────────────────────────────────────────

describe("MappabilityOverrides", () => {
  it("returns undefined when nothing is configured", () => {
    expect(new MappabilityOverrides({ env: {} }).load()).toBeUndefined();
  });

  it("reads symbols, categories and unsupported entries from the environment", () => {
    const override = new MappabilityOverrides({
      env: {
        MARKET_MAPPABILITY_OVERRIDES: JSON.stringify({
          symbols: { binance: ["TONUSDT"] },
          categories: ["entertainment"],
          unsupported: { binance: ["DEADUSDT"] },
        }),
      },
    }).load();

    expect(override).toEqual({
      symbols: { binance: ["TONUSDT"] },
      categories: ["entertainment"],
      unsupported: { binance: ["DEADUSDT"] },
    });
  });

  it("makes a previously unmappable market mappable, with no code change", () => {
    const market = cryptoMarket({
      params: { symbol: "TONUSDT", comparator: "gte", threshold: 5 },
    });

    expect(validateMarketMappability(market, { registry: registry() }).mappable).toBe(false);

    const override = new MappabilityOverrides({
      env: { MARKET_MAPPABILITY_OVERRIDES: JSON.stringify({ symbols: { binance: ["TONUSDT"] } }) },
    }).load();

    expect(validateMarketMappability(market, { registry: registry(), overrides: override }).mappable).toBe(true);
  });

  it("is case-insensitive, so an operator cannot fix a market with the wrong casing", () => {
    const market = cryptoMarket({
      params: { symbol: "tonusdt", comparator: "gte", threshold: 5 },
    });
    const override: MappabilityOverride = { symbols: { binance: ["ToNuSdT"] } };

    expect(validateMarketMappability(market, { registry: registry(), overrides: override }).mappable).toBe(true);
  });

  it("lets an operator mark a delisted symbol unservable despite the defaults", () => {
    const market = cryptoMarket();
    const override: MappabilityOverride = { unsupported: { binance: ["BTCUSDT"] } };

    const verdict = validateMarketMappability(market, { registry: registry(), overrides: override });

    // The point of `unsupported`: a provider removed it, and the shipped
    // default list has not caught up.
    expect(verdict.mappable).toBe(false);
    expect(verdict.reason).toBe("unknown-symbol");
  });

  it("adds a category an adapter serves but the defaults do not list", () => {
    const market: Market = { id: "m", category: "entertainment" as Market["category"], params: {} };
    const override: MappabilityOverride = { categories: ["entertainment"] };

    expect(validateMarketMappability(market, { registry: registry(), overrides: override }).mappable).toBe(true);
  });

  it("reads an override file, merged over the environment", () => {
    const override = new MappabilityOverrides({
      env: { MARKET_MAPPABILITY_OVERRIDES: JSON.stringify({ symbols: { binance: ["A"] } }) },
      filePath: "/etc/ipredict/mappability.json",
      readFile: () => JSON.stringify({ symbols: { binance: ["B"] }, categories: ["sports"] }),
    }).load();

    expect(override?.symbols).toEqual({ binance: ["A", "B"] });
    expect(override?.categories).toEqual(["sports"]);
  });

  it("re-reads the file on every load, so a change takes effect without a restart", () => {
    // The whole point of a file override. A snapshot taken at process start
    // would be no better than no override for the case it exists for.
    let contents = JSON.stringify({ symbols: { binance: ["FIRSTUSDT"] } });
    const overrides = new MappabilityOverrides({
      env: {},
      filePath: "/etc/ipredict/mappability.json",
      readFile: () => contents,
    });

    expect(overrides.load()?.symbols).toEqual({ binance: ["FIRSTUSDT"] });

    contents = JSON.stringify({ symbols: { binance: ["SECONDUSDT"] } });
    expect(overrides.load()?.symbols).toEqual({ binance: ["SECONDUSDT"] });
  });

  it("throws on malformed overrides rather than silently ignoring them", () => {
    // A silently-ignored override looks exactly like "the override applied and
    // had no effect", which is the most confusing possible outcome.
    for (const bad of [
      "not json",
      "[]",
      '{"symbols": "nope"}',
      '{"symbols": {"binance": "nope"}}',
      '{"categories": [1, 2]}',
    ]) {
      expect(
        () => new MappabilityOverrides({ env: { MARKET_MAPPABILITY_OVERRIDES: bad } }).load(),
        bad,
      ).toThrow(/market mappability overrides/);
    }
  });

  it("names the source in the error, so an operator knows which file is broken", () => {
    expect(() =>
      new MappabilityOverrides({
        env: {},
        filePath: "/etc/ipredict/broken.json",
        readFile: () => "{oops",
      }).load(),
    ).toThrow(/\/etc\/ipredict\/broken\.json/);
  });

  it("surfaces an unreadable override file as an error, not a missing override", () => {
    expect(() =>
      new MappabilityOverrides({
        env: {},
        filePath: "/etc/ipredict/missing.json",
        readFile: () => {
          throw new Error("ENOENT: no such file");
        },
      }).load(),
    ).toThrow(/cannot read/);
  });
});

describe("MarketMappabilityRegistry", () => {
  it("exposes the adapter ids it was built for", () => {
    expect(registry(["binance", "coingecko"]).adapterIds).toEqual(["binance", "coingecko"]);
  });

  it("builds from live adapters", () => {
    const built = MarketMappabilityRegistry.fromAdapters([symbolAdapter("binance", ["BTCUSDT"])]);
    expect(built.adapterIds).toEqual(["binance"]);
    expect(built.isSymbolKnown("btcusdt")).toBe(true);
  });

  it("accepts a symbol added at runtime", () => {
    const built = registry();
    expect(built.isSymbolKnown("TONUSDT")).toBe(false);
    built.addSymbols("binance", ["TONUSDT"]);
    expect(built.isSymbolKnown("TONUSDT")).toBe(true);
  });

  it("accepts a category added at runtime", () => {
    const built = registry();
    expect(built.isCategorySupported("entertainment")).toBe(false);
    built.addCategory("entertainment");
    expect(built.isCategorySupported("entertainment")).toBe(true);
  });

  it("only claims symbols for adapters that are actually configured", () => {
    // A binance-only deployment must not consider a CoinMarketCap-only symbol
    // resolvable just because the default table lists it somewhere.
    const built = registry(["binance"]);

    expect(built.isSymbolKnown("BTCUSDT")).toBe(true);
    expect(Object.keys(DEFAULT_MAPPABLE_SYMBOLS)).toContain("coinmarketcap");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep
// ─────────────────────────────────────────────────────────────────────────────

describe("collectUnmappableMarkets", () => {
  const NOW = Date.parse("2026-04-01T12:00:00.000Z");
  const NOW_SECONDS = Math.floor(NOW / 1000);

  function market(overrides: Partial<SweepableMarket> & { id: string }): SweepableMarket {
    return {
      category: "Crypto",
      params: { symbol: "BTCUSDT", comparator: "gte", threshold: 1 },
      endTime: String(NOW_SECONDS + 7 * 24 * 3600),
      ...overrides,
    } as SweepableMarket;
  }

  it("reports an unmappable market, with its time remaining", () => {
    const [found] = collectUnmappableMarkets(
      [market({ id: "bad", params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 } })],
      { registry: registry(), now: NOW },
    );

    expect(found).toBeDefined();
    expect(found!.id).toBe("bad");
    expect(found!.reason).toBe("unknown-symbol");
    expect(found!.secondsUntilExpiry).toBe(7 * 24 * 3600);
    expect(found!.pastExpiry).toBe(false);
    expect(found!.remedy).toBeTruthy();
  });

  it("reports mappable markets as nothing at all", () => {
    expect(collectUnmappableMarkets([market({ id: "ok" })], { registry: registry(), now: NOW })).toEqual([]);
  });

  it("orders by urgency, so the market expiring soonest is first", () => {
    const found = collectUnmappableMarkets(
      [
        market({ id: "far", params: { symbol: "A1", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS + 20 * 86400) }),
        market({ id: "soon", params: { symbol: "B2", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS + 3600) }),
        market({ id: "later", params: { symbol: "C3", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS + 3 * 86400) }),
      ],
      { registry: registry(), now: NOW },
    );

    expect(found.map((m) => m.id)).toEqual(["soon", "later", "far"]);
  });

  it("leads with markets that already expired unresolved — the ones holding stakes", () => {
    const found = collectUnmappableMarkets(
      [
        market({ id: "future", params: { symbol: "A1", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS + 3600) }),
        market({ id: "expired", params: { symbol: "B2", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS - 7200) }),
      ],
      { registry: registry(), now: NOW },
    );

    expect(found.map((m) => m.id)).toEqual(["expired", "future"]);
    expect(found[0]!.pastExpiry).toBe(true);
    expect(found[0]!.secondsUntilExpiry).toBe(-7200);
  });

  it("omits expired markets when asked to", () => {
    const found = collectUnmappableMarkets(
      [market({ id: "expired", params: { symbol: "B2", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS - 7200) })],
      { registry: registry(), now: NOW, includeExpired: false },
    );

    expect(found).toEqual([]);
  });

  it("ignores markets that expire beyond the window", () => {
    const found = collectUnmappableMarkets(
      [
        market({ id: "far", params: { symbol: "A1", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS + 365 * 86400) }),
        market({ id: "near", params: { symbol: "B2", comparator: "gte", threshold: 1 }, endTime: String(NOW_SECONDS + 86400) }),
      ],
      { registry: registry(), now: NOW, withinSeconds: 7 * 86400 },
    );

    expect(found.map((m) => m.id)).toEqual(["near"]);
  });

  it("carries the market's category and question so the report is actionable", () => {
    const [found] = collectUnmappableMarkets(
      [
        market({
          id: "bad",
          question: "Will NOPE reach $1?",
          category: "Crypto",
          params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 },
        }),
      ],
      { registry: registry(), now: NOW },
    );

    expect(found!.category).toBe("Crypto");
    expect(found!.question).toBe("Will NOPE reach $1?");
    expect(found!.detail).toContain("NOPEUSDT");
  });

  it("accepts an ISO end time as well as epoch seconds", () => {
    const [found] = collectUnmappableMarkets(
      [
        market({
          id: "iso",
          params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 },
          endTime: "2026-04-02T12:00:00.000Z",
        }),
      ],
      { registry: registry(), now: NOW },
    );

    expect(found!.secondsUntilExpiry).toBe(86400);
  });

  it("reports markets with no end time rather than dropping them", () => {
    // Dropping a market because its expiry is unreadable is the one way this
    // sweep could silently miss something.
    const [found] = collectUnmappableMarkets(
      [market({ id: "no-end", params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 }, endTime: undefined })],
      { registry: registry(), now: NOW },
    );

    expect(found!.id).toBe("no-end");
    expect(found!.secondsUntilExpiry).toBeUndefined();
    expect(found!.pastExpiry).toBe(false);
  });

  it("clears a market once an override is added, without touching the market", () => {
    const markets = [market({ id: "bad", params: { symbol: "TONUSDT", comparator: "gte", threshold: 1 } })];
    const options = { registry: registry(), now: NOW };

    expect(collectUnmappableMarkets(markets, options)).toHaveLength(1);

    const override: MappabilityOverride = { symbols: { binance: ["TONUSDT"] } };
    expect(collectUnmappableMarkets(markets, { ...options, overrides: override })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep reads from Postgres; the adapters use a different category form
// ─────────────────────────────────────────────────────────────────────────────

describe("category form", () => {
  it("accepts the title-case category Postgres stores", () => {
    // Without normalization the sweep rejects every row in `markets` for an
    // "unsupported category" and reports the whole table as broken.
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["Crypto", { symbol: "BTCUSDT", comparator: "gte", threshold: 1 }],
      ["Sports", { marketId: "game-1", expectedOutcome: "YES" }],
      ["Politics", { marketId: "polymarket-123", expectedOutcome: "YES" }],
      ["Science", { marketId: "study-1", expectedOutcome: "YES" }],
    ];

    for (const [stored, params] of cases) {
      const verdict = validateMarketMappability(
        { id: "m", category: stored as Market["category"], params },
        { registry: registry() },
      );
      expect(verdict.mappable, stored).toBe(true);
    }
  });

  it("still rejects a category no adapter serves, in either form", () => {
    for (const stored of ["Entertainment", "entertainment", "Other"]) {
      const verdict = validateMarketMappability(
        { id: "m", category: stored as Market["category"], params: {} },
        { registry: registry() },
      );
      expect(verdict.mappable, stored).toBe(false);
      expect(verdict.reason, stored).toBe("unsupported-category");
    }
  });

  it("matches an override category case-insensitively too", () => {
    const verdict = validateMarketMappability(
      { id: "m", category: "Entertainment" as Market["category"], params: {} },
      { registry: registry(), overrides: { categories: ["entertainment"] } },
    );
    expect(verdict.mappable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution-time behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveMarket diagnosis", () => {
  it("reports an unmappable market instead of a bare 'unresolvable'", async () => {
    const { resolveMarket } = await import("../src/adapters/resolve.js");
    const market = cryptoMarket({
      id: "m-99",
      params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 },
    });

    const result = await resolveMarket(market, [], { mappabilityRegistry: registry() });

    expect(result.status).toBe("unresolvable");
    // "unresolvable" alone reads as "try again later", and for an unmappable
    // market trying again can never help.
    expect(result.reason?.code).toBe("unmappable");
    expect(result.reason?.unmappableReason).toBe("unknown-symbol");
    expect(result.reason?.detail).toContain("NOPEUSDT");
    expect(result.reason?.mappability?.remedy).toMatch(/MARKET_MAPPABILITY_OVERRIDES/);
  });

  it("says so when every adapter tried and failed, which is a different problem", async () => {
    const { resolveMarket } = await import("../src/adapters/resolve.js");
    const failing: DataAdapter = {
      id: "flaky",
      supports: () => true,
      fetchOutcome: async () => {
        throw new Error("provider 503");
      },
    };

    const result = await resolveMarket(cryptoMarket(), [failing]);

    expect(result.status).toBe("unresolvable");
    expect(result.reason?.code).toBe("all-sources-failed");
    expect(result.reason?.mappability).toBeUndefined();
  });

  it("records why a successful resolution resolved", async () => {
    const { resolveMarket } = await import("../src/adapters/resolve.js");
    const working: DataAdapter = {
      id: "binance",
      supports: () => true,
      fetchOutcome: async () => ({ outcome: true, confidence: 1, raw: {} }),
    };

    const result = await resolveMarket(cryptoMarket(), [working]);

    expect(result.status).toBe("resolved");
    expect(result.reason?.code).toBe("resolved");
  });

  it("can be opted out of, for callers that already validated at creation", async () => {
    const { resolveMarket } = await import("../src/adapters/resolve.js");
    const market = cryptoMarket({ params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 1 } });

    const result = await resolveMarket(market, [], {
      checkMappability: false,
      mappabilityRegistry: registry(),
    });

    expect(result.reason?.code).toBe("all-sources-failed");
    expect(result.reason?.mappability).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions found by running the sweep against a live endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("override beats a live adapter that does not know about it", () => {
  it("reports the market as mappable once an override supplies its symbol", () => {
    // The adapters' `supports()` cannot know about an operator override, so a
    // validator that treated the adapter's refusal as final would make every
    // override a no-op — the override would appear to apply and change
    // nothing. This is the bug the ordering fixes.
    const adapters = [symbolAdapter("binance", ["BTCUSDT"])];
    const market = cryptoMarket({
      id: "m-1",
      params: { symbol: "TONUSDT", comparator: "gte", threshold: 5 },
    });
    const built = MarketMappabilityRegistry.fromAdapters(adapters);
    const override: MappabilityOverride = { symbols: { binance: ["TONUSDT"] } };

    const verdict = validateMarketMappability(market, { adapters, registry: built, overrides: override });

    expect(verdict.mappable).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it("still reports unmappable when neither the adapter nor an override knows it", () => {
    const adapters = [symbolAdapter("binance", ["BTCUSDT"])];
    const market = cryptoMarket({
      id: "m-2",
      params: { symbol: "NOPEUSDT", comparator: "gte", threshold: 5 },
    });

    const verdict = validateMarketMappability(market, {
      adapters,
      registry: MarketMappabilityRegistry.fromAdapters(adapters),
    });

    expect(verdict.mappable).toBe(false);
    expect(verdict.reason).toBe("unknown-symbol");
  });
});

describe("remedy text", () => {
  it("does not suggest appending a quote suffix the symbol already carries", () => {
    // "TIAUSDTUSDT" is a symbol no provider lists, and an operator may take
    // the suggestion literally.
    const [found] = collectUnmappableMarkets(
      [
        {
          id: "m",
          category: "Crypto",
          params: { symbol: "TIAUSDT", comparator: "gte", threshold: 1 },
        },
      ],
      { registry: registry() },
    );

    expect(found!.remedy).toContain('"binance":["TIAUSDT"]');
    expect(found!.remedy).not.toContain("USDTUSDT");
  });

  it("suggests a quote suffix for a bare symbol", () => {
    const [found] = collectUnmappableMarkets(
      [{ id: "m", category: "Crypto", params: { symbol: "TIA", comparator: "gte", threshold: 1 } }],
      { registry: registry() },
    );

    expect(found!.remedy).toContain('"binance":["TIAUSDT"]');
    expect(found!.remedy).toContain('"coinmarketcap":["TIA"]');
  });
});

describe("markets with no params", () => {
  it("is reported as unclassified, never as fine", () => {
    // The database has no params column, so this is the common case for a
    // sweep reading candidates. Assuming "fine" would make the sweep a false
    // clean bill of health.
    const [found] = collectUnmappableMarkets([{ id: "m", category: "Crypto" }], {
      registry: registry(),
    });

    expect(found!.reason).toBe("unknown-params");
    expect(found!.remedy).toMatch(/--params|creation time/);
  });

  it("stays unclassified for a category no adapter serves either", () => {
    // Category is checked first: it is the stronger, cheaper answer.
    const [found] = collectUnmappableMarkets([{ id: "m", category: "Entertainment" }], {
      registry: registry(),
    });

    expect(found!.reason).toBe("unsupported-category");
  });
});
