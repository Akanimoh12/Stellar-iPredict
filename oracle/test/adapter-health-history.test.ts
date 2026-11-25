import { describe, it, expect, beforeEach } from "vitest";
import {
  recordAdapterHealthEntry,
  getAdapterHealthHistory,
  getAdapterHealthTrend,
  clearAdapterHealthHistory,
  checkAdapterHealth,
} from "../src/adapters/health.js";
import type { DataAdapter } from "../src/adapters/index.js";

describe("Adapter Health History and Trends (Issue #910)", () => {
  beforeEach(() => {
    clearAdapterHealthHistory();
  });

  it("records health entries and maintains rolling window", () => {
    const adapterId = "test-adapter";
    for (let i = 0; i < 60; i++) {
      recordAdapterHealthEntry(
        adapterId,
        { available: true, checkedAt: new Date().toISOString(), latencyMs: 20 },
        50,
      );
    }

    const history = getAdapterHealthHistory(adapterId);
    expect(history).toHaveLength(50);
  });

  it("calculates trend as healthy when all recent checks succeed", () => {
    const adapterId = "crypto-binance";
    for (let i = 0; i < 10; i++) {
      recordAdapterHealthEntry(adapterId, {
        available: true,
        checkedAt: new Date().toISOString(),
        latencyMs: 15,
      });
    }

    const trend = getAdapterHealthTrend(adapterId);
    expect(trend.adapterId).toBe(adapterId);
    expect(trend.availabilityRate).toBe(1.0);
    expect(trend.healthScore).toBe(1.0);
    expect(trend.trend).toBe("healthy");
    expect(trend.totalChecks).toBe(10);
  });

  it("calculates degrading trend when failures occur", () => {
    const adapterId = "sports-adapter";
    // 6 successes followed by 4 failures
    for (let i = 0; i < 6; i++) {
      recordAdapterHealthEntry(adapterId, {
        available: true,
        checkedAt: new Date().toISOString(),
        latencyMs: 10,
      });
    }
    for (let i = 0; i < 4; i++) {
      recordAdapterHealthEntry(adapterId, {
        available: false,
        checkedAt: new Date().toISOString(),
        latencyMs: 100,
        error: "Connection timeout",
      });
    }

    const trend = getAdapterHealthTrend(adapterId);
    expect(trend.trend).toBe("degrading");
    expect(trend.failedChecks).toBe(4);
    expect(trend.availabilityRate).toBe(0.6);
  });

  it("calculates failing trend when all recent checks fail", () => {
    const adapterId = "failing-adapter";
    for (let i = 0; i < 5; i++) {
      recordAdapterHealthEntry(adapterId, {
        available: false,
        checkedAt: new Date().toISOString(),
        latencyMs: 50,
        error: "Unauthorized",
      });
    }

    const trend = getAdapterHealthTrend(adapterId);
    expect(trend.trend).toBe("failing");
    expect(trend.healthScore).toBe(0);
  });

  it("includes healthScore and trend in checkAdapterHealth output", async () => {
    const mockAdapter: DataAdapter = {
      id: "mock-crypto",
      category: "crypto",
      resolve: async () => ({
        status: "resolved",
        outcome: true,
        confidence: 1,
        sources: [],
      }),
      checkHealth: async () => ({
        available: true,
        checkedAt: new Date().toISOString(),
        latencyMs: 25,
      }),
    };

    const report = await checkAdapterHealth(mockAdapter, { cacheTtlMs: 0 });
    expect(report.healthScore).toBe(1.0);
    expect(report.trend).toBe("healthy");
    expect(report.adapterId).toBe("mock-crypto");
  });
});
