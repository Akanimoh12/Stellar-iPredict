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
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertBondDiscrepancy(
      "market-123",
      "GABC123",
      1000000000n,
      null,
      ["GABC123"],
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond refund discrepancy detected",
      expect.objectContaining({
        type: "oracle.aggregator.bond_discrepancy",
        severity: "SEV1",
        marketId: "market-123",
        submitter: "GABC123",
        expectedAmountStroops: "1000000000",
        actualAmountStroops: null,
        affectedParties: ["GABC123"],
      }),
    );
  });

  it("handles actual amount when settlement exists with wrong amount", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertBondDiscrepancy(
      "market-456",
      "GXYZ789",
      2000000000n,
      1500000000n,
      ["GXYZ789"],
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond refund discrepancy detected",
      expect.objectContaining({
        actualAmountStroops: "1500000000",
      }),
    );
  });
});

describe("alertBondReconciliationFailure (Issue #573)", () => {
  it("creates a critical alert with failure details", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const error = new Error("Database connection timeout");
    error.stack = "Error: Database connection timeout\n  at test.ts:123";
    
    alertBondReconciliationFailure(
      error,
      42,
      "2026-09-28T10:00:00Z",
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond reconciliation job failed",
      expect.objectContaining({
        type: "oracle.aggregator.bond_reconciliation_failure",
        severity: "SEV1",
        error: "Database connection timeout",
        checkedCount: 42,
        lastSuccessfulRun: "2026-09-28T10:00:00Z",
      }),
    );
  });

  it("handles null lastSuccessfulRun", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertBondReconciliationFailure(
      new Error("First run failed"),
      0,
      null,
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond reconciliation job failed",
      expect.objectContaining({
        lastSuccessfulRun: "never",
      }),
    );
  });
});

describe("alertStuckMarket", () => {
  it("creates a warning alert for markets below critical threshold", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertStuckMarket("market-789", 3.5, undefined, logger as any);
    
    expect(logger.warn).toHaveBeenCalledWith(
      "market stuck - warning lag",
      expect.objectContaining({
        type: "oracle.aggregator.stuck_market",
        severity: "SEV2",
        marketId: "market-789",
        lagHours: 3.5,
      }),
    );
  });

  it("creates a critical alert for markets exceeding critical threshold", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertStuckMarket("market-999", 7, undefined, logger as any);
    
    expect(logger.error).toHaveBeenCalledWith(
      "market stuck - critical lag",
      expect.objectContaining({
        severity: "SEV1",
        marketId: "market-999",
        lagHours: 7,
      }),
    );
  });
});

describe("alertCircuitBreakerOpen", () => {
  it("creates a warning alert when circuit breaker opens", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertCircuitBreakerOpen("polymarket", 0.75, undefined, logger as any);
    
    expect(logger.warn).toHaveBeenCalledWith(
      "circuit breaker opened",
      expect.objectContaining({
        type: "oracle.aggregator.circuit_breaker_open",
        severity: "SEV2",
        adapter: "polymarket",
        failureRate: 0.75,
      }),
    );
  });
});
