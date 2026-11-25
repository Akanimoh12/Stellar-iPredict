import { describe, expect, it, vi } from "vitest";
import { executeReconciliation, parseMaintenanceArgs } from "../maintenance.js";

describe("indexer maintenance CLI (#942)", () => {
  it("parses all supported commands and protects unsafe flag combinations", () => {
    expect(parseMaintenanceArgs(["backfill"])).toEqual({
      command: "backfill", dryRun: false, verifyOnChain: false, failOnDrift: false,
    });
    expect(parseMaintenanceArgs(["totals", "--dry-run", "--verify-onchain", "--fail-on-drift"])).toEqual({
      command: "totals", dryRun: true, verifyOnChain: true, failOnDrift: true,
    });
    expect(() => parseMaintenanceArgs(["nonsense"])).toThrow("Unknown maintenance command");
    expect(() => parseMaintenanceArgs(["backfill", "--dry-run"])).toThrow(/Backfill/);
    expect(() => parseMaintenanceArgs(["bet-counts", "--verify-onchain"])).toThrow(/only supported for totals/);
    expect(() => parseMaintenanceArgs(["totals", "--fail-on-drift"])).toThrow(/requires/);
    expect(() => parseMaintenanceArgs(["totals", "--mistyped"])).toThrow("Unknown maintenance option");
  });

  function db() {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE markets")) return { rows: [{ id: 1 }] };
      if (sql.includes("COUNT(*)::text")) return { rows: [{ count: "4" }] };
      if (sql.includes("SELECT id, total_yes::text")) return {
        rows: [{ id: "1", total_yes: "20", total_no: "0" }],
      };
      return { rows: [] };
    });
    return { query };
  }

  it("rolls back a dry-run bet-count reconciliation", async () => {
    const stub = db();
    const result = await executeReconciliation(stub, parseMaintenanceArgs(["bet-counts", "--dry-run"]));
    expect(result).toEqual({ checked: 4, corrected: 1 });
    expect(stub.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", expect.stringContaining("UPDATE markets"),
      expect.stringContaining("COUNT(*)::text"), "ROLLBACK",
    ]);
  });

  it("commits a successful totals run and reports chain drift", async () => {
    const stub = db();
    const result = await executeReconciliation(
      stub, parseMaintenanceArgs(["totals", "--verify-onchain"]),
      { getOnChainTotals: async () => ({ total_yes: 21n, total_no: 0n }) },
    );
    expect(result).toMatchObject({ checked: 4, corrected: 1, onChainChecked: 1, driftCount: 1 });
    expect(stub.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rolls back on errors (including RPC verification failure)", async () => {
    const stub = db();
    await expect(executeReconciliation(
      stub, parseMaintenanceArgs(["totals", "--verify-onchain"]),
      { getOnChainTotals: async () => { throw new Error("RPC down"); } },
    )).rejects.toThrow("RPC down");
    expect(stub.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});
