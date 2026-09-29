import { describe, expect, it, vi } from "vitest";

import {
  AdapterRegistry,
  FixtureReplayAdapter,
  RecordingAdapter,
  type AdapterOutcome,
  type DataAdapter,
  type Market,
} from "../src/adapters/index.js";
import type { AdapterFixture, FixtureSink } from "../src/adapters/fixtures.js";

const cryptoMarket: Market = {
  id: "btc-above-100k-2025",
  category: "crypto",
  params: { symbol: "BTCUSDT", comparator: "gte", threshold: 100_000 },
};

const politicsMarket: Market = {
  id: "election-2024",
  category: "politics",
  params: { marketId: "pres-2024", expectedOutcome: "YES" },
};

function outcome(overrides: Partial<AdapterOutcome> = {}): AdapterOutcome {
  return { outcome: true, confidence: 0.9, raw: { price: "101234.50" }, ...overrides };
}

/** A deterministic in-memory adapter — no network, fixed recorded response. */
function stubAdapter(
  id: string,
  supported: (m: Market) => boolean,
  result: AdapterOutcome,
): DataAdapter & { calls: Market[] } {
  const calls: Market[] = [];
  return {
    id,
    calls,
    supports: supported,
    async fetchOutcome(market) {
      calls.push(market);
      return structuredClone(result);
    },
  };
}

function memorySink(): FixtureSink & { written: AdapterFixture[] } {
  const written: AdapterFixture[] = [];
  return { written, async write(fixture) { written.push(fixture); } };
}

describe("FixtureReplayAdapter", () => {
  const fixture: AdapterFixture = {
    version: 1,
    adapterId: "binance",
    market: cryptoMarket,
    outcome: outcome(),
    recordedAt: "2025-01-01T00:00:00.000Z",
  };

  it("carries the recorded adapter id", () => {
    expect(new FixtureReplayAdapter(fixture).id).toBe("binance");
  });

  it("supports only the exact recorded market (category + id)", () => {
    const replay = new FixtureReplayAdapter(fixture);
    expect(replay.supports(cryptoMarket)).toBe(true);
    expect(replay.supports({ ...cryptoMarket, id: "other" })).toBe(false);
    expect(replay.supports({ ...cryptoMarket, category: "politics" })).toBe(false);
  });

  it("replays the recorded outcome without network access", async () => {
    const replay = new FixtureReplayAdapter(fixture);
    await expect(replay.fetchOutcome(cryptoMarket)).resolves.toEqual(fixture.outcome);
  });

  it("returns a fresh copy each call so callers can't mutate the fixture", async () => {
    const replay = new FixtureReplayAdapter(fixture);
    const first = await replay.fetchOutcome(cryptoMarket);
    (first.raw as Record<string, unknown>).price = "tampered";
    first.confidence = 0;
    const second = await replay.fetchOutcome(cryptoMarket);
    expect(second).toEqual(fixture.outcome);
    expect(second.confidence).toBe(0.9);
  });

  it("throws for a market it did not record", async () => {
    const replay = new FixtureReplayAdapter(fixture);
    await expect(replay.fetchOutcome(politicsMarket)).rejects.toThrow(
      /does not match market/,
    );
  });
});

describe("RecordingAdapter", () => {
  it("mirrors the wrapped adapter's id and support decision", () => {
    const inner = stubAdapter("coingecko", (m) => m.category === "crypto", outcome());
    const rec = new RecordingAdapter(inner, memorySink());
    expect(rec.id).toBe("coingecko");
    expect(rec.supports(cryptoMarket)).toBe(true);
    expect(rec.supports(politicsMarket)).toBe(false);
  });

  it("returns the wrapped outcome and records it through the sink exactly once", async () => {
    const recorded = outcome({ confidence: 0.42 });
    const inner = stubAdapter("coingecko", () => true, recorded);
    const sink = memorySink();
    const rec = new RecordingAdapter(inner, sink);

    const result = await rec.fetchOutcome(cryptoMarket);

    expect(result).toEqual(recorded);
    expect(inner.calls).toEqual([cryptoMarket]);
    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]).toMatchObject({
      version: 1,
      adapterId: "coingecko",
      market: cryptoMarket,
      outcome: recorded,
    });
    expect(typeof sink.written[0].recordedAt).toBe("string");
  });

  it("round-trips: a recorded fixture replays to the same outcome", async () => {
    const recorded = outcome({ outcome: false, confidence: 0.71, raw: { note: "x" } });
    const sink = memorySink();
    await new RecordingAdapter(stubAdapter("reuters", () => true, recorded), sink).fetchOutcome(
      politicsMarket,
    );

    const replay = new FixtureReplayAdapter(sink.written[0]);
    expect(replay.id).toBe("reuters");
    expect(replay.supports(politicsMarket)).toBe(true);
    await expect(replay.fetchOutcome(politicsMarket)).resolves.toEqual(recorded);
  });

  it("propagates a provider failure without writing a fixture", async () => {
    const inner: DataAdapter = {
      id: "flaky",
      supports: () => true,
      fetchOutcome: vi.fn().mockRejectedValue(new Error("provider 503")),
    };
    const sink = memorySink();
    await expect(
      new RecordingAdapter(inner, sink).fetchOutcome(cryptoMarket),
    ).rejects.toThrow("provider 503");
    expect(sink.written).toHaveLength(0);
  });
});

describe("AdapterRegistry", () => {
  it("returns supporting adapters in registration order", () => {
    const primary = stubAdapter("primary", (m) => m.category === "crypto", outcome());
    const fallback = stubAdapter("fallback", (m) => m.category === "crypto", outcome());
    const unrelated = stubAdapter("politics-only", (m) => m.category === "politics", outcome());

    const registry = new AdapterRegistry();
    registry.register(primary);
    registry.register(unrelated);
    registry.register(fallback);

    expect(registry.adaptersFor(cryptoMarket).map((a) => a.id)).toEqual([
      "primary",
      "fallback",
    ]);
    expect(registry.adaptersFor(politicsMarket).map((a) => a.id)).toEqual(["politics-only"]);
    expect(registry.list()).toHaveLength(3);
  });

  it("looks adapters up by id", () => {
    const a = stubAdapter("a", () => true, outcome());
    const registry = new AdapterRegistry();
    registry.register(a);
    expect(registry.getById("a")).toBe(a);
    expect(registry.getById("missing")).toBeUndefined();
  });
});
