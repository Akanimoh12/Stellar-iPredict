import { describe, expect, it, vi } from "vitest";
import { resolveMarket, DEFAULT_CATEGORY_CONFIG, DEFAULT_OPTIONS } from "../src/adapters/resolve.js";
import { PolymarketFeedAdapter } from "../src/adapters/polymarketfeed.js";
import { ReutersAdapter } from "../src/adapters/reuters.js";
import {
  FixtureReplayAdapter,
  InMemoryReviewQueue,
  type AdapterFixture,
  type DataAdapter,
  type Market,
} from "../src/adapters/index.js";
import polymarketFixture from "./fixtures/polymarket-politics.json";
import reutersFixture from "./fixtures/reuters-politics.json";

function createPoliticsMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "us-election-2024",
    category: "politics",
    params: {
      marketId: "us-election-2024",
      expectedOutcome: "YES",
    },
    ...overrides,
  };
}

function createStubAdapter(
  id: string,
  outcome: boolean | null,
  confidence = 1.0,
  error?: string,
): DataAdapter {
  return {
    id,
    supports: () => true,
    fetchOutcome: async () => {
      if (error) throw new Error(error);
      return { outcome, confidence, raw: { id } };
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("Politics: conservative confidence gating", () => {
  it("defines conservative gating defaults for politics", () => {
    expect(DEFAULT_CATEGORY_CONFIG.politics).toEqual({
      minAgreement: 2,
      maxSources: Infinity,
      conflictThreshold: 0.15,
      minConfidence: 0.85,
    });

    // Standard categories remain 1-source with 0.7 confidence floor
    expect(DEFAULT_CATEGORY_CONFIG.crypto.minAgreement).toBe(1);
    expect(DEFAULT_CATEGORY_CONFIG.crypto.minConfidence).toBe(0.7);
    expect(DEFAULT_CATEGORY_CONFIG.sports.minAgreement).toBe(1);
    expect(DEFAULT_CATEGORY_CONFIG.sports.minConfidence).toBe(0.7);
    expect(DEFAULT_CATEGORY_CONFIG.science.minAgreement).toBe(1);
    expect(DEFAULT_CATEGORY_CONFIG.science.minConfidence).toBe(0.7);
  });

  it("requires at least 2 agreeing sources for political outcomes (single source is unresolvable)", async () => {
    const primary = createStubAdapter("polymarket", true, 0.95);
    const market = createPoliticsMarket();

    // With only 1 source, politics market cannot resolve because minAgreement = 2
    const result = await resolveMarket(market, [primary]);

    expect(result.status).toBe("unresolvable");
    expect(result.outcome).toBeUndefined();
    expect(result.confidence).toBe(0);
    expect(result.sources).toHaveLength(1);
  });

  it("resolves when 2 political sources agree with high confidence", async () => {
    const polymarket = createStubAdapter("polymarket", true, 0.95);
    const reuters = createStubAdapter("reuters", true, 0.90);
    const market = createPoliticsMarket();

    const result = await resolveMarket(market, [polymarket, reuters]);

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.925);
    expect(result.sources).toHaveLength(2);
  });

  it("flags conflict when political sources disagree under strict 0.15 conflictThreshold", async () => {
    const polymarket = createStubAdapter("polymarket", true, 0.95);
    const reuters = createStubAdapter("reuters", false, 0.90);
    const market = createPoliticsMarket();

    const result = await resolveMarket(market, [polymarket, reuters]);

    expect(result.status).toBe("conflict");
    expect(result.outcome).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it("enqueues into reviewQueue with conflicting_outcomes on disagreement", async () => {
    const queue = new InMemoryReviewQueue();
    const polymarket = createStubAdapter("polymarket", true, 0.95);
    const reuters = createStubAdapter("reuters", false, 0.90);
    const market = createPoliticsMarket();

    const result = await resolveMarket(market, [polymarket, reuters], { reviewQueue: queue });

    expect(result.status).toBe("review");
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({
      reason: "conflicting_outcomes",
      market,
    });
  });

  it("holds agreeing sources for manual review when confidence is below conservative 0.85 threshold", async () => {
    const queue = new InMemoryReviewQueue();
    // Two sources agree on outcome=true, but with moderate confidence (0.80 avg < 0.85)
    const sourceA = createStubAdapter("sourceA", true, 0.80);
    const sourceB = createStubAdapter("sourceB", true, 0.80);
    const market = createPoliticsMarket();

    const result = await resolveMarket(market, [sourceA, sourceB], { reviewQueue: queue });

    expect(result.status).toBe("review");
    expect(result.outcome).toBeUndefined();
    expect(result.confidence).toBeCloseTo(0.80);
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({
      reason: "low_confidence",
      confidence: 0.80,
      market,
    });
  });

  it("allows custom categoryConfig override for politics", async () => {
    const primary = createStubAdapter("single-source", true, 0.95);
    const market = createPoliticsMarket();

    // Explicitly configure politics minAgreement = 1 for this call
    const result = await resolveMarket(market, [primary], {
      categoryConfigs: {
        politics: { minAgreement: 1, minConfidence: 0.90 },
      },
    });

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });

  it("allows direct options overrides to take precedence over category defaults", async () => {
    const primary = createStubAdapter("single-source", true, 0.95);
    const market = createPoliticsMarket();

    // Direct minAgreement option overrides category default
    const result = await resolveMarket(market, [primary], { minAgreement: 1 });

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });

  describe("Quota-safe fixture-based resolution", () => {
    it("resolves politics market using Polymarket and Reuters adapter fixtures without network calls", async () => {
      const polyFetch = vi.fn().mockResolvedValue(jsonResponse(polymarketFixture));
      const reutersFetch = vi.fn().mockResolvedValue(jsonResponse(reutersFixture));

      const polyAdapter = new PolymarketFeedAdapter({ fetchFn: polyFetch });
      const reutersAdapter = new ReutersAdapter({
        apiKey: "fixture-key",
        fetchFn: reutersFetch,
      });

      const market = createPoliticsMarket({
        params: {
          marketId: "us-election-2024",
          expectedOutcome: "Candidate A",
        },
      });

      const result = await resolveMarket(market, [polyAdapter, reutersAdapter]);

      expect(polyFetch).toHaveBeenCalledTimes(1);
      expect(reutersFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("resolved");
      expect(result.outcome).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.sources).toHaveLength(2);
      expect(result.sources[0].adapterId).toBe("polymarketfeed");
      expect(result.sources[1].adapterId).toBe("reuters");
    });

    it("replays recorded political fixtures deterministically with FixtureReplayAdapter", async () => {
      const market = createPoliticsMarket();

      const polyFixture: AdapterFixture = {
        version: 1,
        adapterId: "polymarketfeed",
        market,
        outcome: { outcome: true, confidence: 0.95, raw: polymarketFixture },
        recordedAt: "2026-08-27T00:00:00Z",
      };

      const reutersFixtureData: AdapterFixture = {
        version: 1,
        adapterId: "reuters",
        market,
        outcome: { outcome: true, confidence: 0.90, raw: reutersFixture },
        recordedAt: "2026-08-27T00:00:00Z",
      };

      const polyReplay = new FixtureReplayAdapter(polyFixture);
      const reutersReplay = new FixtureReplayAdapter(reutersFixtureData);

      const result = await resolveMarket(market, [polyReplay, reutersReplay]);

      expect(result.status).toBe("resolved");
      expect(result.outcome).toBe(true);
      expect(result.confidence).toBeCloseTo(0.925);
    });
  });
});
