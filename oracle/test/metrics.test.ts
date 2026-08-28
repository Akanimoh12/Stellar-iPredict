import { describe, expect, it } from "vitest";
import { AggregatorMetrics, ORACLE_RESOLUTION_LAG_H_METRIC } from "../src/aggregator/metrics.js";

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

  // ── oracle_resolution_lag_h named metric ────────────────────────────────────

  it("exposes ORACLE_RESOLUTION_LAG_H_METRIC constant with the correct value", () => {
    expect(ORACLE_RESOLUTION_LAG_H_METRIC).toBe("oracle_resolution_lag_h");
  });

  it("getMetric returns null before any resolution is recorded", () => {
    const metrics = new AggregatorMetrics();
    expect(metrics.getMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "42")).toBeNull();
  });

  it("getMetric returns the correct NamedMetric after recording", () => {
    const metrics = new AggregatorMetrics();
    const endTime = 2_000_000;
    const resolvedAt = endTime + 3 * 3_600; // 3 h lag
    metrics.recordResolution("99", endTime, resolvedAt);

    const named = metrics.getMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "99");
    expect(named).not.toBeNull();
    expect(named!.name).toBe("oracle_resolution_lag_h");
    expect(named!.marketId).toBe("99");
    expect(named!.value).toBeCloseTo(3);
  });

  it("getMetric returns the most recent observation when a market is recorded twice", () => {
    const metrics = new AggregatorMetrics();
    const base = 1_000_000;
    metrics.recordResolution("7", base, base + 1 * 3_600); // first: 1 h
    metrics.recordResolution("7", base, base + 5 * 3_600); // second: 5 h (most recent)

    const named = metrics.getMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "7");
    expect(named!.value).toBeCloseTo(5);
  });

  it("getMetric returns null for an unknown market even when others are recorded", () => {
    const metrics = new AggregatorMetrics();
    metrics.recordResolution("10", 0, 3_600);
    expect(metrics.getMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "99")).toBeNull();
  });

  it("serializeMetric returns null before any resolution", () => {
    const metrics = new AggregatorMetrics();
    expect(metrics.serializeMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "42")).toBeNull();
  });

  it("serializeMetric emits a correctly formatted Prometheus text line", () => {
    const metrics = new AggregatorMetrics();
    const endTime = 1_000_000;
    const resolvedAt = endTime + 2.5 * 3_600; // 2.5 h
    metrics.recordResolution("42", endTime, resolvedAt);

    const line = metrics.serializeMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "42");
    expect(line).toBe(`oracle_resolution_lag_h{market_id="42"} 2.5`);
  });

  it("serializeMetric uses the exact metric name oracle_resolution_lag_h as the key", () => {
    const metrics = new AggregatorMetrics();
    metrics.recordResolution("5", 0, 7_200); // 2 h
    const line = metrics.serializeMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "5");
    expect(line).toMatch(/^oracle_resolution_lag_h\{/);
  });

  it("serializeAll returns empty array when no resolutions recorded", () => {
    const metrics = new AggregatorMetrics();
    expect(metrics.serializeAll(ORACLE_RESOLUTION_LAG_H_METRIC)).toEqual([]);
  });

  it("serializeAll returns all observations newest-first", () => {
    const metrics = new AggregatorMetrics();
    const base = 1_000_000;
    metrics.recordResolution("a", base, base + 1 * 3_600); // 1 h
    metrics.recordResolution("b", base, base + 2 * 3_600); // 2 h
    metrics.recordResolution("c", base, base + 3 * 3_600); // 3 h

    const lines = metrics.serializeAll(ORACLE_RESOLUTION_LAG_H_METRIC);
    expect(lines).toHaveLength(3);
    // newest first → "c", "b", "a"
    expect(lines[0]).toMatch(/market_id="c"/);
    expect(lines[1]).toMatch(/market_id="b"/);
    expect(lines[2]).toMatch(/market_id="a"/);
  });

  it("serializeAll lines all start with oracle_resolution_lag_h", () => {
    const metrics = new AggregatorMetrics();
    metrics.recordResolution("x", 0, 3_600);
    metrics.recordResolution("y", 0, 7_200);
    for (const line of metrics.serializeAll(ORACLE_RESOLUTION_LAG_H_METRIC)) {
      expect(line).toMatch(/^oracle_resolution_lag_h\{/);
    }
  });
});
