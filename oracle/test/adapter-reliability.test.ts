import { describe, expect, it, vi } from "vitest";
import {
  checkAdapterHealth,
  FixtureReplayAdapter,
  InMemoryReviewQueue,
  RecordingAdapter,
  type AdapterFixture,
  type DataAdapter,
  type Market,
} from "../src/adapters/index.js";
import { resolveMarket } from "../src/adapters/resolve.js";

const market: Market = {
  id: "btc-100k",
  category: "crypto",
  params: { symbol: "BTCUSDT", comparator: "gte", threshold: 100_000 },
};

function adapter(id: string, outcome: boolean, confidence: number): DataAdapter {
  return { id, supports: () => true, fetchOutcome: async () => ({ outcome, confidence, raw: { id } }) };
}

describe("adapter health checks", () => {
  it("reports availability and caches probes to preserve quota", async () => {
    const probe = vi.fn().mockResolvedValue({ available: true, checkedAt: "2026-01-01T00:00:00.000Z", latencyMs: 4 });
    const source = { ...adapter("health-source", true, 1), checkHealth: probe };
    const first = await checkAdapterHealth(source, { cacheTtlMs: 60_000 });
    const second = await checkAdapterHealth(source, { cacheTtlMs: 60_000 });
    expect(first).toMatchObject({ adapterId: "health-source", available: true, cached: false });
    expect(second.cached).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("reports probe failures without rejecting the health report", async () => {
    const source = { ...adapter("failed-source", true, 1), checkHealth: async () => { throw new Error("offline"); } };
    await expect(checkAdapterHealth(source, { cacheTtlMs: 0 })).resolves.toMatchObject({ available: false, error: "offline" });
  });
});

describe("manual review queue", () => {
  it("routes low-confidence results to review", async () => {
    const queue = new InMemoryReviewQueue();
    const result = await resolveMarket(market, [adapter("source", true, 0.4)], { reviewQueue: queue });
    expect(result.status).toBe("review");
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ reason: "low_confidence", confidence: 0.4 });
  });

  it("routes conflicting outcomes to review exactly once", async () => {
    const queue = new InMemoryReviewQueue();
    const result = await resolveMarket(market, [adapter("one", true, 1), adapter("two", false, 1)], {
      conflictThreshold: 0,
      reviewQueue: queue,
    });
    expect(result.status).toBe("review");
    expect(queue.list()[0].reason).toBe("conflicting_outcomes");
  });
});

describe("adapter fixture recording and replay", () => {
  it("records a response and replays it deterministically without another provider call", async () => {
    const provider = adapter("fixture-source", true, 0.9);
    const fixtures: AdapterFixture[] = [];
    const recording = new RecordingAdapter(provider, { write: async (fixture) => { fixtures.push(fixture); } });
    const recorded = await recording.fetchOutcome(market);
    const replay = new FixtureReplayAdapter(fixtures[0]);
    expect(await replay.fetchOutcome(market)).toEqual(recorded);
    expect(replay.supports({ ...market, id: "other" })).toBe(false);
  });
});
