import { describe, expect, it, vi, beforeEach } from "vitest";
import { 
  alertBondDiscrepancy,
  alertBondReconciliationFailure,
  alertStuckMarket,
  alertAggregateLag,
  alertCircuitBreakerOpen,
  THRESHOLDS,
} from "../src/aggregator/alert.js";

describe("alertBondDiscrepancy (Issue #573)", () => {
  it("creates a critical alert with bond details", () => {
    // Mock console to capture the alert
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    alertBondDiscrepancy(
      "market-123",
      "GABC123",
      1000000000n,
      null,
      ["GABC123"],
    );
    
    expect(consoleSpy).toHaveBeenCalledWith(
      "[ALERT]",
      expect.stringContaining("market-123"),
    );
    
    // Parse the JSON alert from the second argument
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    
    expect(alert).toMatchObject({
      level: "critical",
      type: "bond_discrepancy",
      message: "Bond refund discrepancy detected for market market-123",
      context: {
        marketId: "market-123",
        submitter: "GABC123",
        expectedAmountStroops: "1000000000",
        actualAmountStroops: "null",
        affectedParties: ["GABC123"],
        severity: "P0",
      },
    });
    
    consoleSpy.mockRestore();
  });

  it("handles actual amount when settlement exists with wrong amount", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    alertBondDiscrepancy(
      "market-456",
      "GXYZ789",
      2000000000n,
      1500000000n, // Actual is less than expected
      ["GXYZ789"],
    );
    
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    expect(alert.context.actualAmountStroops).toBe("1500000000");
    
    consoleSpy.mockRestore();
  });
});

describe("alertBondReconciliationFailure (Issue #573)", () => {
  it("creates a critical alert with failure details", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Database connection timeout");
    error.stack = "Error: Database connection timeout\n  at test.ts:123";
    
    alertBondReconciliationFailure(
      error,
      42,
      "2026-09-28T10:00:00Z",
    );
    
    expect(consoleSpy).toHaveBeenCalledWith(
      "[ALERT]",
      expect.stringContaining("Bond reconciliation job failed"),
    );
    
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    
    expect(alert).toMatchObject({
      level: "critical",
      type: "bond_reconciliation_failure",
      context: {
        error: "Database connection timeout",
        checkedCount: 42,
        lastSuccessfulRun: "2026-09-28T10:00:00Z",
        severity: "P0",
      },
    });
    expect(alert.context.stack).toContain("Database connection timeout");
    
    consoleSpy.mockRestore();
  });

  it("handles null lastSuccessfulRun", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    alertBondReconciliationFailure(
      new Error("First run failed"),
      0,
      null,
    );
    
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    expect(alert.context.lastSuccessfulRun).toBe("never");
    
    consoleSpy.mockRestore();
  });
});

describe("alertStuckMarket", () => {
  it("creates a warning alert for markets below critical threshold", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    alertStuckMarket("market-789", 3.5);
    
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    
    expect(alert.level).toBe("warning");
    expect(alert.type).toBe("stuck_market");
    expect(alert.context.marketId).toBe("market-789");
    expect(alert.context.lagHours).toBe(3.5);
    
    consoleSpy.mockRestore();
  });

  it("creates a critical alert for markets exceeding critical threshold", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    alertStuckMarket("market-999", 7);
    
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    
    expect(alert.level).toBe("critical");
    
    consoleSpy.mockRestore();
  });
});

describe("alertCircuitBreakerOpen", () => {
  it("creates a critical alert when circuit breaker opens", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    alertCircuitBreakerOpen("polymarket", 0.75);
    
    const alertJson = consoleSpy.mock.calls[0]?.[1] as string;
    const alert = JSON.parse(alertJson);
    
    expect(alert.level).toBe("critical");
    expect(alert.type).toBe("circuit_breaker");
    expect(alert.context.adapter).toBe("polymarket");
    expect(alert.context.failureRate).toBe(0.75);
    
    consoleSpy.mockRestore();
  });
});
