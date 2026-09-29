import { describe, expect, it, vi } from "vitest";
import { resolveMarket } from "../src/adapters/resolve.js";
import type { DataAdapter, Market } from "../src/adapters/index.js";

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "crypto",
    params: { symbol: "BTCUSDT", comparator: "gte", threshold: 50_000 },
    ...overrides,
  };
}

function createStubAdapter(
  id: string,
  outcome: boolean | null,
  error?: string,
): DataAdapter {
  return {
    id,
    supports: () => true,
    fetchOutcome: async () => {
      if (error) throw new Error(error);
      return { outcome, confidence: 1, raw: {} };
    },
  };
}

describe("resolveMarket", () => {
  it("returns resolved with the first successful source when minAgreement is 1", async () => {
    const primary = createStubAdapter("primary", true);
    const result = await resolveMarket(createMarket(), [primary]);

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].adapterId).toBe("primary");
  });

  it("falls back to secondary when primary fails", async () => {
    const primary = createStubAdapter("primary", null, "network error");
    const secondary = createStubAdapter("secondary", false);

    const result = await resolveMarket(createMarket(), [primary, secondary]);

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(false);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].error).toBe("network error");
    expect(result.sources[1].adapterId).toBe("secondary");
  });

  it("falls back through multiple sources until one succeeds", async () => {
    const primary = createStubAdapter("primary", null, "timeout");
    const secondary = createStubAdapter("secondary", null, "timeout");
    const tertiary = createStubAdapter("tertiary", true);

    const result = await resolveMarket(createMarket(), [primary, secondary, tertiary]);

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
    expect(result.sources).toHaveLength(3);
    expect(result.sources[2].adapterId).toBe("tertiary");
  });

  it("returns conflict when sources disagree beyond the threshold", async () => {
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", false);
    const tertiary = createStubAdapter("tertiary", false);

    const result = await resolveMarket(createMarket(), [primary, secondary, tertiary], {
      minAgreement: 2,
      conflictThreshold: 0.3,
    });

    expect(result.status).toBe("conflict");
    expect(result.outcome).toBeUndefined();
  });

  it("returns resolved when sources agree", async () => {
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", true);

    const result = await resolveMarket(createMarket(), [primary, secondary], {
      minAgreement: 2,
    });

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });

  it("returns unresolvable when all sources fail", async () => {
    const primary = createStubAdapter("primary", null, "timeout");
    const secondary = createStubAdapter("secondary", null, "timeout");

    const result = await resolveMarket(createMarket(), [primary, secondary]);

    expect(result.status).toBe("unresolvable");
    expect(result.outcome).toBeUndefined();
    expect(result.sources).toHaveLength(2);
  });

  it("respects maxSources limit", async () => {
    const primary = createStubAdapter("primary", null, "timeout");
    const secondary = createStubAdapter("secondary", true);
    const tertiary = createStubAdapter("tertiary", false);

    const result = await resolveMarket(createMarket(), [primary, secondary, tertiary], {
      maxSources: 2,
    });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].adapterId).toBe("primary");
    expect(result.sources[1].adapterId).toBe("secondary");
    expect(result.status).toBe("resolved");
  });

  it("returns conflict when disagreement exceeds conflictThreshold", async () => {
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", false);

    const result = await resolveMarket(createMarket(), [primary, secondary], {
      minAgreement: 1,
      conflictThreshold: 0.0,
    });

    expect(result.status).toBe("conflict");
  });

  it("returns resolved when disagreement is within conflictThreshold", async () => {
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", false);
    const tertiary = createStubAdapter("tertiary", true);

    const result = await resolveMarket(createMarket(), [primary, secondary, tertiary], {
      minAgreement: 1,
      conflictThreshold: 0.4,
    });

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });

  it("computes average confidence from successful sources", async () => {
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", true);

    const result = await resolveMarket(createMarket(), [primary, secondary], {
      minAgreement: 2,
    });

    expect(result.confidence).toBe(1);
  });

  it("ignores failed sources when computing agreement", async () => {
    const failing = createStubAdapter("failing", null, "timeout");
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", true);

    const result = await resolveMarket(createMarket(), [failing, primary, secondary], {
      minAgreement: 2,
    });

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
    expect(result.sources).toHaveLength(3);
  });

  it("supports per-category configuration via options", async () => {
    const primary = createStubAdapter("primary", true);
    const secondary = createStubAdapter("secondary", false);

    const result = await resolveMarket(createMarket(), [primary, secondary], {
      minAgreement: 2,
      conflictThreshold: 0.3,
    });

    expect(result.status).toBe("conflict");
  });

  it("applies conservative confidence gating by default for politics category", async () => {
    const politicsMarket: Market = {
      id: "pol-1",
      category: "politics",
      params: { marketId: "election-2024", expectedOutcome: "YES" },
    };
    const primary = createStubAdapter("primary", true);

    // Single source is unresolvable for politics because default minAgreement is 2
    const singleResult = await resolveMarket(politicsMarket, [primary]);
    expect(singleResult.status).toBe("unresolvable");

    // Two agreeing sources resolve successfully
    const secondary = createStubAdapter("secondary", true);
    const dualResult = await resolveMarket(politicsMarket, [primary, secondary]);
    expect(dualResult.status).toBe("resolved");
    expect(dualResult.outcome).toBe(true);
  });
});