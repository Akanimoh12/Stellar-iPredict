import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  reconcileBonds,
  runBondReconciliation,
  runBondReconciliationSafe,
  recordSettlement,
  type TerminalSubmission,
  type BondSettlement,
  type BondReconciliationOptions,
} from "../src/aggregator/bond-reconciliation.js";
import * as alertModule from "../src/aggregator/alert.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubmission(marketId: string, overrides: Partial<TerminalSubmission> = {}): TerminalSubmission {
  return {
    marketId,
    submitter: "GXXX",
    bondAmount: 100_0000000n,
    status: "finalized",
    finalizedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeSettlement(marketId: string, overrides: Partial<BondSettlement> = {}): BondSettlement {
  return {
    marketId,
    recipient: "GXXX",
    settledAmount: 100_0000000n,
    settledAt: new Date("2026-01-01T01:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reconcileBonds (pure unit tests)
// ---------------------------------------------------------------------------

describe("reconcileBonds", () => {
  it("returns empty array when all submissions are settled", () => {
    const subs = [makeSubmission("1"), makeSubmission("2")];
    const settlements = [makeSettlement("1"), makeSettlement("2")];
    expect(reconcileBonds(subs, settlements)).toHaveLength(0);
  });

  it("flags submissions with no matching settlement", () => {
    const subs = [makeSubmission("1"), makeSubmission("2")];
    const settlements = [makeSettlement("1")];
    const result = reconcileBonds(subs, settlements);
    expect(result).toHaveLength(1);
    expect(result[0]?.marketId).toBe("2");
  });

  it("flags all submissions when settlements is empty", () => {
    const subs = [makeSubmission("1"), makeSubmission("2"), makeSubmission("3")];
    const result = reconcileBonds(subs, []);
    expect(result).toHaveLength(3);
  });

  it("returns empty array when both inputs are empty", () => {
    expect(reconcileBonds([], [])).toHaveLength(0);
  });

  it("preserves submission metadata on discrepancy", () => {
    const finalizedAt = new Date("2026-06-15T12:00:00Z");
    const sub = makeSubmission("42", {
      submitter: "GABC",
      bondAmount: 200_0000000n,
      status: "cancelled",
      finalizedAt,
    });
    const [disc] = reconcileBonds([sub], []);
    expect(disc?.submitter).toBe("GABC");
    expect(disc?.expectedAmount).toBe(200_0000000n);
    expect(disc?.status).toBe("cancelled");
    expect(disc?.finalizedAt).toEqual(finalizedAt);
    expect(disc?.detectedAt).toMatch(/^\d{4}-/); // ISO timestamp
  });
});

// ---------------------------------------------------------------------------
// runBondReconciliation (DB-integrated, pool is mocked)
// ---------------------------------------------------------------------------

describe("runBondReconciliation", () => {
  function buildPool(submissions: object[], settlements: object[]) {
    return {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("oracle_submissions")) return { rows: submissions };
        if (sql.includes("bond_settlements")) return { rows: settlements };
        return { rows: [] };
      }),
    };
  }

  it("returns summary with no discrepancies when all are settled", async () => {
    const pool = buildPool(
      [{ market_id: "1", submitter: "GXXX", bond_amount: "1000000000", status: "finalized", finalized_at: "2026-01-01" }],
      [{ market_id: "1", recipient: "GXXX", settled_amount: "1000000000", settled_at: "2026-01-02" }],
    );
    const result = await runBondReconciliation(pool);
    expect(result.checkedCount).toBe(1);
    expect(result.settledCount).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
  });

  it("calls onDiscrepancy for each unsettled submission and logs discrepancies", async () => {
    const pool = buildPool(
      [
        { market_id: "1", submitter: "GXXX", bond_amount: "1000000000", status: "finalized", finalized_at: "2026-01-01T00:00:00Z" },
        { market_id: "2", submitter: "GYYY", bond_amount: "2500000000", status: "cancelled", finalized_at: "2026-01-02T00:00:00Z" },
      ],
      [{ market_id: "1", recipient: "GXXX", settled_amount: "1000000000", settled_at: "2026-01-02T00:00:00Z" }],
    );

    const alerts: string[] = [];
    const warn = vi.fn();
    const info = vi.fn();
    const logger = { warn, info, error: vi.fn(), debug: vi.fn() };
    const options: BondReconciliationOptions = {
      onDiscrepancy: (d) => { alerts.push(d.marketId); },
      logger: logger as unknown as BondReconciliationOptions["logger"],
    };

    const result = await runBondReconciliation(pool, options);
    expect(result.checkedCount).toBe(2);
    expect(result.settledCount).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      marketId: "2",
      submitter: "GYYY",
      expectedAmount: 2500000000n,
      status: "cancelled",
    });
    expect(alerts).toEqual(["2"]);
    expect(warn).toHaveBeenCalledWith(
      "bond refund discrepancy detected",
      expect.objectContaining({
        marketId: "2",
        submitter: "GYYY",
        expectedAmountStroops: "2500000000",
        status: "cancelled",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "bond reconciliation complete",
      expect.objectContaining({
        checkedCount: 2,
        settledCount: 1,
        discrepancyCount: 1,
      }),
    );

    // Verify SQL filter includes finalized, cancelled, and expired statuses
    const [subQuery] = (pool.query as any).mock.calls[0];
    expect(subQuery).toContain("WHERE status IN ('finalized', 'cancelled', 'expired')");
  });

  it("returns ranAt as an ISO timestamp", async () => {
    const pool = buildPool([], []);
    const result = await runBondReconciliation(pool);
    expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls alertBondDiscrepancy for each discrepancy (Issue #573)", async () => {
    const alertSpy = vi.spyOn(alertModule, "alertBondDiscrepancy");
    
    const pool = buildPool(
      [
        { market_id: "1", submitter: "GXXX", bond_amount: "1000000000", status: "finalized", finalized_at: "2026-01-01" },
        { market_id: "2", submitter: "GYYY", bond_amount: "2000000000", status: "finalized", finalized_at: "2026-01-01" },
      ],
      [], // No settlements
    );

    await runBondReconciliation(pool);

    expect(alertSpy).toHaveBeenCalledTimes(2);
    // Updated to match new signature with optional webhookUrl and logger
    expect(alertSpy).toHaveBeenCalledWith("1", "GXXX", 1000000000n, null, ["GXXX"], undefined, undefined);
    expect(alertSpy).toHaveBeenCalledWith("2", "GYYY", 2000000000n, null, ["GYYY"], undefined, undefined);
    
    alertSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runBondReconciliationSafe (wrapper that alerts on failure)
// ---------------------------------------------------------------------------

describe("runBondReconciliationSafe", () => {
  function buildPool(submissions: object[], settlements: object[]) {
    return {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("oracle_submissions")) return { rows: submissions };
        if (sql.includes("bond_settlements")) return { rows: settlements };
        return { rows: [] };
      }),
    };
  }

  it("returns result when reconciliation succeeds", async () => {
    const pool = buildPool(
      [{ market_id: "1", submitter: "GXXX", bond_amount: "1000000000", status: "finalized", finalized_at: "2026-01-01" }],
      [{ market_id: "1", recipient: "GXXX", settled_amount: "1000000000", settled_at: "2026-01-02" }],
    );
    
    const result = await runBondReconciliationSafe(pool);
    expect(result).not.toBeNull();
    expect(result?.checkedCount).toBe(1);
  });

  it("alerts and re-throws when reconciliation fails (Issue #573)", async () => {
    const alertSpy = vi.spyOn(alertModule, "alertBondReconciliationFailure");
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("Database connection lost")),
    };
    
    await expect(runBondReconciliationSafe(pool, {}, "2026-09-28T10:00:00Z")).rejects.toThrow("Database connection lost");
    
    expect(alertSpy).toHaveBeenCalledTimes(1);
    // Updated to match new signature with webhookUrl and logger
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Database connection lost" }),
      0,
      "2026-09-28T10:00:00Z",
      undefined,
      undefined,
    );
    
    alertSpy.mockRestore();
  });

  it("alerts with null lastSuccessfulRun when not provided", async () => {
    const alertSpy = vi.spyOn(alertModule, "alertBondReconciliationFailure");
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("Query timeout")),
    };
    
    await expect(runBondReconciliationSafe(pool)).rejects.toThrow("Query timeout");
    
    // Updated to match new signature
    expect(alertSpy).toHaveBeenCalledWith(
      expect.any(Error),
      0,
      null,
      undefined,
      undefined,
    );
    
    alertSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// recordSettlement (idempotency / double-payout guard)
// ---------------------------------------------------------------------------

describe("recordSettlement", () => {
  it("returns true when a new row is inserted", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ market_id: "1" }] }),
    };
    const result = await recordSettlement(pool, {
      marketId: "1",
      recipient: "GXXX",
      settledAmountStroops: 100_0000000n,
    });
    expect(result).toBe(true);
  });

  it("returns false when the row already exists (ON CONFLICT DO NOTHING)", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }), // no RETURNING row → conflict
    };
    const result = await recordSettlement(pool, {
      marketId: "1",
      recipient: "GXXX",
      settledAmountStroops: 100_0000000n,
    });
    expect(result).toBe(false);
  });

  it("passes marketId, recipient, and amount to the query at exact positional indices", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ market_id: "5" }] }),
    };
    await recordSettlement(pool, {
      marketId: "5",
      recipient: "GABC",
      settledAmountStroops: 200_0000000n,
    });
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT");
    expect(params[0]).toBe("5");
    expect(params[1]).toBe("GABC");
    expect(params[2]).toBe("2000000000");
  });
});
