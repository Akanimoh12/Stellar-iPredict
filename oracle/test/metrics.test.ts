import { describe, expect, it } from "vitest";
import { AggregatorMetrics } from "../src/aggregator/metrics.js";

describe("AggregatorMetrics", () => {
  it("records a resolution and exposes lag in hours", () => {
    const metrics = new AggregatorMetrics();
    const endTime = 1_000_000;
    const resolvedAt = endTime + 2 * 3_600; // 2 hours later
    const entry = metrics.recordResolution("42", endTime, resolvedAt);
    expect(entry.lagHours).toBeCloseTo(2);
    expect(entry.marketId).toBe("42");
  });

  it("reports a correct snapshot over multiple resolutions", () => {
    const metrics = new AggregatorMetrics();
    const base = 1_000_000;
    metrics.recordResolution("1", base, base + 1 * 3_600); // 1h
    metrics.recordResolution("2", base, base + 3 * 3_600); // 3h
    metrics.recordResolution("3", base, base + 5 * 3_600); // 5h

    const snap = metrics.snapshot();
    expect(snap.totalResolved).toBe(3);
    expect(snap.averageLagHours).toBeCloseTo(3);
    expect(snap.maxLagHours).toBeCloseTo(5);
    expect(snap.minLagHours).toBeCloseTo(1);
  });

  it("returns entries in reverse chronological order", () => {
    const metrics = new AggregatorMetrics();
    const base = 1_000_000;
    metrics.recordResolution("first", base, base + 3_600);
    metrics.recordResolution("second", base, base + 7_200);

    const snap = metrics.snapshot();
    expect(snap.entries[0].marketId).toBe("second");
    expect(snap.entries[1].marketId).toBe("first");
  });

  it("returns zeroed snapshot when no resolutions recorded", () => {
    const metrics = new AggregatorMetrics();
    const snap = metrics.snapshot();
    expect(snap.totalResolved).toBe(0);
    expect(snap.averageLagHours).toBe(0);
    expect(snap.maxLagHours).toBe(0);
    expect(snap.minLagHours).toBe(0);
    expect(snap.entries).toEqual([]);
  });

  it("handles negative lag when resolution occurs before expiry", () => {
    const metrics = new AggregatorMetrics();
    const endTime = 1_000_000;
    const resolvedAt = endTime - 1_800; // 0.5h before expiry
    const entry = metrics.recordResolution("42", endTime, resolvedAt);
    expect(entry.lagHours).toBeCloseTo(-0.5);
  });

  it("tracks totalResolved count", () => {
    const metrics = new AggregatorMetrics();
    expect(metrics.totalResolved).toBe(0);
    metrics.recordResolution("1", 0, 3_600);
    metrics.recordResolution("2", 0, 7_200);
    expect(metrics.totalResolved).toBe(2);
  });

  it("resets all recorded metrics", () => {
    const metrics = new AggregatorMetrics();
    metrics.recordResolution("1", 0, 3_600);
    metrics.reset();
    expect(metrics.totalResolved).toBe(0);
    expect(metrics.snapshot().entries).toEqual([]);
  });
});
