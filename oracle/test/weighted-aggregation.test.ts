import { describe, expect, it } from "vitest";
import { resolveMarket } from "../src/adapters/resolve.js";
import type { DataAdapter, Market } from "../src/adapters/index.js";

const market: Market = {
  id: "market-w",
  category: "crypto",
  params: { symbol: "BTCUSDT", comparator: "gte", threshold: 50_000 },
};

function adapter(id: string, outcome: boolean, confidence: number): DataAdapter {
  return {
    id,
    supports: () => true,
    fetchOutcome: async () => ({ outcome, confidence, raw: {} }),
  };
}

describe("confidence-weighted aggregation", () => {
  it("lets a high-confidence source outweigh a low-confidence dissenter", async () => {
    // 1 vs 1 by count would be a conflict; by weight 1.0 vs 0.1 is decisive.
    const result = await resolveMarket(
      market,
      [adapter("fresh", true, 1), adapter("stale", false, 0.1)],
      { conflictThreshold: 0.3, minConfidence: 0.5 },
    );

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });

  it("can overturn a head-count majority when the minority carries the weight", async () => {
    const result = await resolveMarket(
      market,
      [adapter("a", false, 0.1), adapter("b", false, 0.1), adapter("c", true, 1)],
      { conflictThreshold: 0.5, minConfidence: 0.1 },
    );

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });

  it("flags a weighted near-tie as inconclusive rather than picking a side", async () => {
    const result = await resolveMarket(
      market,
      [adapter("a", true, 0.9), adapter("b", false, 0.85)],
      { conflictThreshold: 0.6, minConfidence: 0.5, minWeightedMargin: 0.1 },
    );

    expect(result.status).toBe("conflict");
    expect(result.outcome).toBeUndefined();
    expect(result.reason?.code).toBe("inconclusive");
  });

  it("falls back to head-count and low-confidence review when every source reports zero confidence", async () => {
    const result = await resolveMarket(market, [adapter("a", true, 0), adapter("b", true, 0)]);

    expect(result.status).toBe("review");
    expect(result.reason?.code).toBe("low-confidence");
  });

  it("behaves like an unweighted vote when all confidences are equal", async () => {
    const result = await resolveMarket(
      market,
      [adapter("a", true, 1), adapter("b", true, 1), adapter("c", false, 1)],
      { conflictThreshold: 0.4 },
    );

    expect(result.status).toBe("resolved");
    expect(result.outcome).toBe(true);
  });
});
