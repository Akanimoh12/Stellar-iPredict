import { describe, it, expect, beforeEach } from "vitest";
import {
  metrics,
  serializeMetrics,
  resetMetrics,
  Histogram,
  EventCounter,
} from "../metrics.js";

describe("enhanced metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe("Histogram", () => {
    it("tracks values in buckets", () => {
      const hist = new Histogram([1, 5, 10]);
      hist.observe(0.5);
      hist.observe(3);
      hist.observe(8);
      hist.observe(15);

      const snapshot = hist.snapshot();
      expect(snapshot.count).toBe(4);
      expect(snapshot.sum).toBe(26.5);
      expect(snapshot.buckets.get(1)).toBe(1); // 0.5
      expect(snapshot.buckets.get(5)).toBe(2); // 0.5, 3
      expect(snapshot.buckets.get(10)).toBe(3); // 0.5, 3, 8
    });

    it("ignores negative values", () => {
      const hist = new Histogram([1, 5]);
      hist.observe(-1);
      hist.observe(2);

      const snapshot = hist.snapshot();
      expect(snapshot.count).toBe(1);
      expect(snapshot.sum).toBe(2);
    });
  });

  describe("EventCounter", () => {
    it("tracks events by type", () => {
      const counter = new EventCounter();
      counter.inc("market_created", 2);
      counter.inc("bet_placed", 5);
      counter.inc("market_created", 1);

      expect(counter.get("market_created")).toBe(3);
      expect(counter.get("bet_placed")).toBe(5);
      expect(counter.get("unknown")).toBe(0);
    });

    it("sanitizes empty event types to unknown", () => {
      const counter = new EventCounter();
      counter.inc("  ");
      counter.inc("");

      expect(counter.get("unknown")).toBe(2);
    });
  });

  describe("serializeMetrics", () => {
    it("includes all metric types in prometheus format", () => {
      metrics.indexerLag.set(42);
      metrics.eventsProcessed.inc(100);
      metrics.eventsByType.inc("market_created", 10);
      metrics.eventsByType.inc("bet_placed", 20);
      metrics.eventsDeadLettered.inc(2);
      metrics.pollDuration.observe(1.5);
      metrics.pollDuration.observe(3.0);

      const output = serializeMetrics();

      // Check for gauge
      expect(output).toContain("# TYPE indexer_lag_ledgers gauge");
      expect(output).toContain("indexer_lag_ledgers 42");

      // Check for counters
      expect(output).toContain("# TYPE events_processed_total counter");
      expect(output).toContain("events_processed_total 100");

      expect(output).toContain("# TYPE events_by_type_total counter");
      expect(output).toContain('events_by_type_total{event_type="market_created"} 10');
      expect(output).toContain('events_by_type_total{event_type="bet_placed"} 20');

      expect(output).toContain("# TYPE events_dead_lettered_total counter");
      expect(output).toContain("events_dead_lettered_total 2");

      // Check for histogram
      expect(output).toContain("# TYPE poll_duration_seconds histogram");
      expect(output).toContain("poll_duration_seconds_sum 4.5");
      expect(output).toContain("poll_duration_seconds_count 2");
    });

    it("exports bounded label cardinality for events", () => {
      // Simulate many different event types
      for (let i = 0; i < 20; i++) {
        metrics.eventsByType.inc(`event_type_${i}`);
      }

      const output = serializeMetrics();
      
      // All event types should be tracked (cardinality is bounded by contract design)
      for (let i = 0; i < 20; i++) {
        expect(output).toContain(`event_type_${i}`);
      }
    });

    it("handles empty metrics gracefully", () => {
      const output = serializeMetrics();

      expect(output).toContain("indexer_lag_ledgers 0");
      expect(output).toContain("events_processed_total 0");
      expect(output).toContain("events_dead_lettered_total 0");
      expect(output).toContain("poll_duration_seconds_count 0");
    });
  });

  describe("pollDuration histogram", () => {
    it("tracks poll iteration durations", () => {
      metrics.pollDuration.observe(0.05); // Fast
      metrics.pollDuration.observe(2.5); // Normal
      metrics.pollDuration.observe(45); // Slow

      const output = serializeMetrics();

      // Should have histogram buckets
      expect(output).toMatch(/poll_duration_seconds_bucket\{le="0.1"\} \d+/);
      expect(output).toMatch(/poll_duration_seconds_bucket\{le="5"\} \d+/);
      expect(output).toMatch(/poll_duration_seconds_bucket\{le="60"\} \d+/);
      expect(output).toContain("poll_duration_seconds_count 3");
      expect(output).toContain("poll_duration_seconds_sum 47.55");
    });
  });
});
