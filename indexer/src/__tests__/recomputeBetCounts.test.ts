import { describe, expect, it, vi } from "vitest";
import { recomputeMarketBetCountsFromBets } from "../recomputeBetCounts.js";

describe("recomputeMarketBetCountsFromBets", () => {
  it("recomputes bet_count from the bets table and reports drift", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (text: string, params?: readonly unknown[]): Promise<{ rows: any[] }> => {
        queries.push({ text, params });

        // The UPDATE ... RETURNING returns one row per corrected market.
        if (text.includes("UPDATE markets")) {
          return { rows: [{ id: 1 }, { id: 2 }] };
        }

        // The market count query.
        if (text.includes("COUNT(*)::text")) {
          return { rows: [{ count: "5" }] };
        }

        return { rows: [] };
      }),
    };

    const result = await recomputeMarketBetCountsFromBets(db);

    expect(result).toEqual({ checked: 5, corrected: 2 });

    // Derives counts from bets and reconciles against every market (incl. zero).
    expect(queries[0]?.text).toContain("FROM bets");
    expect(queries[0]?.text).toContain("COUNT(*)::int AS bet_count");
    expect(queries[0]?.text).toContain("LEFT JOIN counts");
    expect(queries[0]?.text).toContain("UPDATE markets");
    expect(queries[0]?.text).toContain("m.bet_count IS DISTINCT FROM e.bet_count");
  });

  it("reports zero corrections when stored counts already match", async () => {
    const db = {
      query: vi.fn(async (text: string): Promise<{ rows: any[] }> => {
        if (text.includes("UPDATE markets")) return { rows: [] };
        if (text.includes("COUNT(*)::text")) return { rows: [{ count: "3" }] };
        return { rows: [] };
      }),
    };

    const result = await recomputeMarketBetCountsFromBets(db);

    expect(result).toEqual({ checked: 3, corrected: 0 });
  });

  it("defaults checked to 0 when the market count query returns nothing", async () => {
    const db = {
      query: vi.fn(async (text: string): Promise<{ rows: any[] }> => {
        if (text.includes("UPDATE markets")) return { rows: [] };
        return { rows: [] };
      }),
    };

    const result = await recomputeMarketBetCountsFromBets(db);

    expect(result).toEqual({ checked: 0, corrected: 0 });
  });
});
