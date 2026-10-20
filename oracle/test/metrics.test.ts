import { describe, expect, it } from "vitest";
import {
  AggregatorMetrics,
  ORACLE_RESOLUTION_LAG_H_METRIC,
  assessAggregatorAvailability,
  createPostgresResolutionMetricStore,
} from "../src/aggregator/metrics.js";
import type { QueryablePool } from "../src/aggregator/tally.js";

describe("AggregatorMetrics", () => {
  it("writes resolution observations idempotently to Postgres", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const pool: QueryablePool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };

    await createPostgresResolutionMetricStore(pool).recordResolution({
      marketId: "42",
      endTime: 1_000_000,
      resolvedAt: 1_007_200,
      lagHours: 2,
    });

    expect(queries[0].sql).toContain("oracle_resolution_lag");
    expect(queries[0].sql).toContain("ON CONFLICT (market_id) DO NOTHING");
    expect(queries[0].params).toEqual(["42", 1_000_000, 1_007_200, 2]);
  });

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

// ── Aggregator availability (issue #645) ────────────────────────────────────
describe("assessAggregatorAvailability", () => {
  const opts = { degradedAfterMs: 15 * 60_000, alertAfterMs: 60 * 60_000 };

  it("is unavailable and alerting when no poll has ever completed", () => {
    const a = assessAggregatorAvailability({ lastPollCompletedAt: null, now: 1_000, ...opts });
    expect(a.available).toBe(false);
    expect(a.degraded).toBe(true);
    expect(a.shouldAlert).toBe(true);
    expect(a.level).toBe("critical");
    expect(a.sinceLastPollMs).toBeNull();
  });

  it("is available while the last poll is within the degraded threshold", () => {
    const now = 100 * 60_000;
    const a = assessAggregatorAvailability({ lastPollCompletedAt: now - 5 * 60_000, now, ...opts });
    expect(a.available).toBe(true);
    expect(a.degraded).toBe(false);
    expect(a.shouldAlert).toBe(false);
    expect(a.level).toBe("ok");
  });

  it("degrades after 15m and alerts after 60m", () => {
    const now = 100 * 60_000;
    const degraded = assessAggregatorAvailability({ lastPollCompletedAt: now - 20 * 60_000, now, ...opts });
    expect(degraded.degraded).toBe(true);
    expect(degraded.shouldAlert).toBe(false);
    expect(degraded.level).toBe("degraded");

    const alerting = assessAggregatorAvailability({ lastPollCompletedAt: now - 75 * 60_000, now, ...opts });
    expect(alerting.shouldAlert).toBe(true);
    expect(alerting.level).toBe("critical");
  });
});

describe("AggregatorMetrics availability", () => {
  it("tracks the last completed poll and clears the failure streak", () => {
    const m = new AggregatorMetrics();
    m.recordPollFailure();
    m.recordPollFailure();
    expect(m.availability(10_000).consecutiveFailures).toBe(2);

    m.recordPollCompleted(9_000);
    const a = m.availability(9_500);
    expect(a.lastPollCompletedAt).toBe(9_000);
    expect(a.consecutiveFailures).toBe(0);
    expect(a.available).toBe(true);
  });

  it("serializeAvailability reports 0 unavailable-seconds while healthy", () => {
    const m = new AggregatorMetrics();
    m.recordPollCompleted(1_000);
    const lines = m.serializeAvailability(2_000);
    expect(lines).toContain("oracle_aggregator_unavailable_seconds 0");
    expect(lines).toContain("oracle_aggregator_available 1");
  });

  it("serializeAvailability reports the stall length once degraded", () => {
    const m = new AggregatorMetrics();
    m.recordPollCompleted(0);
    const lines = m.serializeAvailability(20 * 60_000, { degradedAfterMs: 15 * 60_000, alertAfterMs: 60 * 60_000 });
    expect(lines).toContain("oracle_aggregator_unavailable_seconds 1200");
    expect(lines).toContain("oracle_aggregator_available 0");
  });
});

describe("AggregatorMetrics Prometheus export & histogram (#450)", () => {
  it("converts resolution lag to a histogram with bucket counts and sum", () => {
    const m = new AggregatorMetrics();
    // Expiry: 0
    m.recordResolution("m1", 0, 1800); // 0.5h lag (falls into <=0.5 bucket)
    m.recordResolution("m2", 0, 7200); // 2h lag (falls into <=2 bucket)
    m.recordResolution("m3", 0, 18000); // 5h lag (falls into <=8 bucket)

    const hist = m.lagHistogram;
    expect(hist.count).toBe(3);
    expect(hist.sum).toBeCloseTo(7.5); // 0.5 + 2 + 5 = 7.5

    // Check buckets: 0.25 (0), 0.5 (1), 1 (1), 2 (2), 4 (2), 8 (3), +Inf (3)
    const b0_5Index = hist.buckets.indexOf(0.5);
    const b2Index = hist.buckets.indexOf(2);
    const b8Index = hist.buckets.indexOf(8);
    const infIndex = hist.buckets.indexOf(Infinity);

    expect(hist.counts[b0_5Index]).toBe(1);
    expect(hist.counts[b2Index]).toBe(2);
    expect(hist.counts[b8Index]).toBe(3);
    expect(hist.counts[infIndex]).toBe(3);
  });

  it("caps in-memory entries array to prevent unbounded memory growth", () => {
    const m = new AggregatorMetrics();
    for (let i = 0; i < 70; i++) {
      m.recordResolution(`market-${i}`, 0, 3600);
    }

    expect(m.snapshot().entries.length).toBeLessThanOrEqual(AggregatorMetrics.MAX_ENTRIES);
    expect(m.snapshot().entries.length).toBe(50);
    expect(m.lagHistogram.count).toBe(70); // histogram retains full count
  });

  it("tracks market processing counters", () => {
    const m = new AggregatorMetrics();
    expect(m.marketsProcessed).toBe(0);
    expect(m.marketsFinalized).toBe(0);
    expect(m.marketsSkipped).toBe(0);
    expect(m.marketsFailed).toBe(0);

    m.recordMarketProcessed();
    m.recordMarketProcessed();
    m.recordMarketFinalized();
    m.recordMarketSkipped();
    m.recordMarketFailed();

    expect(m.marketsProcessed).toBe(2);
    expect(m.marketsFinalized).toBe(1);
    expect(m.marketsSkipped).toBe(1);
    expect(m.marketsFailed).toBe(1);
  });

  it("formats Prometheus exposition text according to conventions", () => {
    const m = new AggregatorMetrics();
    m.recordMarketProcessed();
    m.recordMarketFinalized();
    m.recordResolution("10", 0, 3600); // 1h lag

    const text = m.toPrometheus();
    expect(text).toContain("# TYPE oracle_aggregator_markets_processed_total counter");
    expect(text).toContain("oracle_aggregator_markets_processed_total 1");
    expect(text).toContain("# TYPE oracle_aggregator_markets_finalized_total counter");
    expect(text).toContain("oracle_aggregator_markets_finalized_total 1");
    expect(text).toContain("# TYPE oracle_aggregator_resolution_lag_hours histogram");
    expect(text).toContain('oracle_aggregator_resolution_lag_hours_bucket{le="1"} 1');
    expect(text).toContain('oracle_aggregator_resolution_lag_hours_bucket{le="+Inf"} 1');
    expect(text).toContain("oracle_aggregator_resolution_lag_hours_count 1");
  });

  it("AggregatorMetricsServer serves /metrics and /health over HTTP", async () => {
    const { AggregatorMetricsServer } = await import("../src/aggregator/metrics.js");
    const m = new AggregatorMetrics();
    m.recordMarketProcessed();

    const server = new AggregatorMetricsServer({
      metrics: m,
      port: 0, // random ephemeral port
      host: "127.0.0.1",
    });

    await server.start();
    const addr = server.address();
    expect(addr).not.toBeNull();

    try {
      const res = await fetch(`http://127.0.0.1:${addr!.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toContain("oracle_aggregator_markets_processed_total 1");

      const healthRes = await fetch(`http://127.0.0.1:${addr!.port}/health`);
      expect(healthRes.status).toBe(200);
      const healthBody = await healthRes.json();
      expect(healthBody).toEqual({ status: "ok" });
    } finally {
      await server.stop();
    }
  });
});

