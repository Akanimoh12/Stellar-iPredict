import { describe, expect, it, vi } from "vitest";
import { recomputeMarketTotalsFromBets } from "../recomputeTotals.js";

describe("recomputeMarketTotalsFromBets (#941)", () => {
  function fixture() {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE markets")) return { rows: [{ id: 2 }] };
      if (sql.includes("COUNT(*)::text")) return { rows: [{ count: "2" }] };
      if (sql.includes("SELECT id, total_yes::text")) return {
        rows: [
          { id: "1", total_yes: "150", total_no: "0" },
          { id: "2", total_yes: "0", total_no: "0" },
        ],
      };
      return { rows: [] };
    });
    return { query };
  }

  it("reconciles markets without bets and preserves legacy result shape", async () => {
    const db = fixture();
    expect(await recomputeMarketTotalsFromBets(db)).toEqual({ checked: 2, corrected: 1 });
    expect(db.query.mock.calls[0][0]).toContain("LEFT JOIN totals");
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("compares exact bigint stroops and reports only mismatched markets", async () => {
    const db = fixture();
    const onDrift = vi.fn();
    const getOnChainTotals = vi.fn(async (id: string) => id === "1"
      ? { total_yes: 150n, total_no: 0n }
      : { total_yes: "123", total_no: "0" });
    const result = await recomputeMarketTotalsFromBets(db, { getOnChainTotals, onDrift });
    expect(result).toEqual({
      checked: 2, corrected: 1, onChainChecked: 2,
      drift: [{
        marketId: "2",
        database: { total_yes: "0", total_no: "0" },
        onChain: { total_yes: "123", total_no: "0" },
      }],
    });
    expect(onDrift).toHaveBeenCalledTimes(1);
    expect(getOnChainTotals).toHaveBeenCalledTimes(2);
  });

  it("fails visibly on a failed chain read rather than claiming parity", async () => {
    await expect(recomputeMarketTotalsFromBets(fixture(), {
      getOnChainTotals: async () => { throw new Error("Soroban RPC unavailable"); },
    })).rejects.toThrow("Soroban RPC unavailable");
  });

  it("rejects unsafe numeric totals instead of silently rounding", async () => {
    await expect(recomputeMarketTotalsFromBets(fixture(), {
      getOnChainTotals: async () => ({ total_yes: Number.MAX_SAFE_INTEGER + 5, total_no: 0 }),
    })).rejects.toThrow(/Unsafe numeric total/);
  });
});
