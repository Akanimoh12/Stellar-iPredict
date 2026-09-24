import { describe, expect, it, vi } from "vitest";
import type { Queryable, MarketRow } from "../src/db/markets.js";
import type { BetRow, OracleSubmissionRow, LeaderboardRow } from "../src/db/types.js";

import { getMarketById, getMarkets } from "../src/db/markets.js";
import { getBetsByBettor, getBetsByMarketFromDb } from "../src/db/bets.js";
import { getLeaderboard, getLeaderboardTotal } from "../src/db/leaderboard.js";
import { getGlobalStats } from "../src/db/stats.js";
import {
  getOracleSubmissionsCount,
  recordOracleSubmission,
} from "../src/db/oracle.js";

function makeMarketRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 1,
    question: "Will XLM hold above $1?",
    image_url: null,
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "100.0000000",
    total_no: "50.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "G" + "A".repeat(55),
    bet_count: 7,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeBetRow(overrides: Partial<BetRow> = {}): BetRow {
  return {
    market_id: "1",
    bettor: "G" + "B".repeat(55),
    net_amount: "25.0000000",
    gross_amount: "25.5000000",
    is_yes: true,
    claimed: false,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeLeaderboardRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    address: "G" + "C".repeat(55),
    display_name: "Alice",
    points: "900",
    won_bets: 9,
    lost_bets: 3,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeQueryable(
  handler: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>,
): Queryable & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(handler),
  } as unknown as Queryable & { query: ReturnType<typeof vi.fn> };
}

describe("db query layer", () => {
  it("gets markets with filters, sorting, and pagination", async () => {
    const row = makeMarketRow({ id: 2, category: "Crypto" });
    const db = makeQueryable(async (sql, values) => {
      if (sql.includes("COUNT(*)::INT AS total FROM markets")) {
        expect(sql).toContain("WHERE category = $1 AND resolved = false AND cancelled = false");
        expect(values).toEqual(["Crypto"]);
        return { rows: [{ total: 1 }] };
      }

      expect(sql).toContain("FROM markets");
      expect(sql).toContain("ORDER BY (total_yes + total_no) DESC, created_at DESC");
      expect(values).toEqual(["Crypto", 5, 5]);
      return { rows: [row] };
    });

    const result = await getMarkets(
      { filter: "active", category: "Crypto", sort: "volume", page: 2, limit: 5 },
      db,
    );

    expect(result).toEqual({
      rows: [row],
      total: 1,
      page: 2,
      limit: 5,
    });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("gets a market by id and returns null when absent", async () => {
    const row = makeMarketRow({ id: 42 });
    const db = makeQueryable(async (sql, values) => {
      expect(sql).toContain("FROM markets");
      expect(values).toEqual([42]);
      return { rows: [row] };
    });

    await expect(getMarketById(42, db)).resolves.toEqual(row);

    const emptyDb = makeQueryable(async () => ({ rows: [] }));
    await expect(getMarketById(999, emptyDb)).resolves.toBeNull();
  });

  it("gets paginated bets for a market", async () => {
    const bet = makeBetRow();
    const db = makeQueryable(async (sql, values) => {
      if (sql.includes("COUNT(*)::INT AS total FROM bets")) {
        expect(values).toEqual([7]);
        return { rows: [{ total: 3 }] };
      }

      expect(sql).toContain("FROM bets");
      expect(values).toEqual([7, 10, 20]);
      return { rows: [bet] };
    });

    const result = await getBetsByMarketFromDb(7, 3, 10, db);

    expect(result).toEqual({
      bets: [bet],
      total: 3,
      page: 3,
      limit: 10,
      totalPages: 1,
    });
  });

  it("gets bets by bettor address", async () => {
    const bet = makeBetRow();
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql).toContain("FROM bets");
      expect(values).toEqual(["G" + "D".repeat(55)]);
      return { rows: [bet] };
    });

    const result = await getBetsByBettor({ query } as unknown as Parameters<typeof getBetsByBettor>[0], "G" + "D".repeat(55));

    expect(result).toEqual([bet]);
  });

  it("gets leaderboard rows sorted by points and by bets", async () => {
    const row = makeLeaderboardRow();
    const pointsDb = makeQueryable(async (sql, values) => {
      expect(sql).toContain("ORDER BY points DESC");
      expect(values).toEqual([20, 0]);
      return { rows: [row] };
    });
    const betsDb = makeQueryable(async (sql, values) => {
      expect(sql).toContain("ORDER BY (won_bets + lost_bets) DESC");
      expect(values).toEqual([20, 0]);
      return { rows: [row] };
    });

    await expect(getLeaderboard(pointsDb as never, { limit: 20, offset: 0, sort: "points" })).resolves.toEqual([row]);
    await expect(getLeaderboard(betsDb as never, { limit: 20, offset: 0, sort: "bets" })).resolves.toEqual([row]);
  });

  it("gets the leaderboard total", async () => {
    const db = makeQueryable(async (sql) => {
      expect(sql).toContain("COUNT(*)::text AS total FROM leaderboard");
      return { rows: [{ total: "17" }] };
    });

    await expect(getLeaderboardTotal(db as never)).resolves.toBe(17);
  });

  it("records oracle submissions and counts submitted rows", async () => {
    const submission = {
      id: 12,
      market_id: 5,
      submitter: "G" + "E".repeat(55),
      outcome: "yes",
      bond_amount: "1000",
      submitted_at: new Date("2026-01-01T00:00:00.000Z"),
      status: "submitted",
    } satisfies OracleSubmissionRow;

    const db = makeQueryable(async (sql, values) => {
      if (sql.includes("INSERT INTO oracle_submissions")) {
        expect(values).toEqual([5, "G" + "E".repeat(55), "yes", "1000", null, null]);
        return { rows: [submission] };
      }

      expect(sql).toContain("COUNT(*)::text AS count");
      expect(values).toEqual([5]);
      return { rows: [{ count: "2" }] };
    });

    await expect(
      recordOracleSubmission(
        { marketId: 5, provider: "G" + "E".repeat(55), outcome: "yes", bondAmount: 1000 },
        db,
      ),
    ).resolves.toEqual(submission);
    await expect(getOracleSubmissionsCount(5, db)).resolves.toBe(2);
  });

  it("returns the current global stats snapshot", async () => {
    const db = makeQueryable(async (sql) => {
      expect(sql).toContain("FROM markets");
      return {
        rows: [
          {
            total_markets: "0",
            total_volume: "0",
            total_users: "0",
            total_bets: "0",
          },
        ],
      };
    });

    await expect(getGlobalStats(db)).resolves.toEqual({
      totalMarkets: 0,
      totalVolume: "0",
      volume: 0n,
      totalUsers: 0,
      totalBets: 0,
    });
  });
});
