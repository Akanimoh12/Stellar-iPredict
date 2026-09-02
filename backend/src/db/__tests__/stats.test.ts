
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getGlobalStats,
  getPlatformStats,
  GLOBAL_STATS_QUERY,
  type Queryable,
} from "../stats.js";
import { seedBets, clearBets } from "../bets.js";
import { upsertLeaderboardEntry, clearLeaderboard } from "../leaderboard.js";

function makeQueryable(
  handler: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
): Queryable {
  return {
    query: vi.fn(handler),
  } as unknown as Queryable;
}

describe("getGlobalStats", () => {
  it("computes live aggregates from database rows matching a seeded fixture", async () => {
    // Seed fixture mimicking db/seed.ts:
    // 3 markets (volume = 2000 + 1550 + 2900 = 6450.0000000)
    // 3 leaderboard users
    // 4 bets
    const db = makeQueryable(async (sql) => {
      expect(sql).toContain("FROM markets");
      expect(sql).toContain("FROM leaderboard");
      expect(sql).toContain("FROM bets");
      return {
        rows: [
          {
            total_markets: "3",
            total_volume: "6450.0000000",
            total_users: "3",
            total_bets: "4",
          },
        ],
      };
    });

    const stats = await getGlobalStats(db);

    expect(stats).toEqual({
      totalMarkets: 3,
      totalVolume: "6450.0000000",
      volume: 6450n,
      totalUsers: 3,
      totalBets: 4,
    });

    expect(typeof stats.totalMarkets).toBe("number");
    expect(typeof stats.totalVolume).toBe("string");
    expect(typeof stats.volume).toBe("bigint");
    expect(typeof stats.totalUsers).toBe("number");
    expect(typeof stats.totalBets).toBe("number");
  });

  it("handles empty database state with zeroed values", async () => {
    const db = makeQueryable(async () => ({
      rows: [
        {
          total_markets: "0",
          total_volume: "0",
          total_users: "0",
          total_bets: "0",
        },
      ],
    }));

    const stats = await getGlobalStats(db);

    expect(stats).toEqual({
      totalMarkets: 0,
      totalVolume: "0",
      volume: 0n,
      totalUsers: 0,
      totalBets: 0,
    });
  });

  it("handles missing/null row gracefully", async () => {
    const db = makeQueryable(async () => ({
      rows: [],
    }));

    const stats = await getGlobalStats(db);

    expect(stats).toEqual({
      totalMarkets: 0,
      totalVolume: "0",
      volume: 0n,
      totalUsers: 0,
      totalBets: 0,
    });
  });

  it("executes the expected aggregate SQL query", () => {
    expect(GLOBAL_STATS_QUERY).toContain("SELECT (SELECT COUNT(*)::text FROM markets) AS total_markets");
    expect(GLOBAL_STATS_QUERY).toContain("COALESCE(SUM(total_yes + total_no), 0)::text FROM markets");
    expect(GLOBAL_STATS_QUERY).toContain("SELECT COUNT(DISTINCT address)::text FROM leaderboard");
    expect(GLOBAL_STATS_QUERY).toContain("SELECT COUNT(*)::text FROM bets");
  });
});

describe("getPlatformStats", () => {
  beforeEach(() => {
    clearBets();
    clearLeaderboard();
  });

  it("returns empty stats when no in-memory data exists", () => {
    const stats = getPlatformStats();
    expect(stats).toEqual({
      bets: {
        totalBets: 0,
        totalVolume: 0,
        uniqueBettors: 0,
        yesCount: 0,
        noCount: 0,
        yesVolume: 0,
        noVolume: 0,
        claimedCount: 0,
        unclaimedCount: 0,
      },
      leaderboard: {
        totalPoints: 0,
        totalWins: 0,
        totalLosses: 0,
        totalEntries: 0,
      },
    });
  });

  it("aggregates bets and leaderboard entries accurately", () => {
    seedBets(1, [
      { address: "GA_USER1", amount: 100, isYes: true, claimed: false },
      { address: "GA_USER2", amount: 200, isYes: false, claimed: true },
    ]);
    seedBets(2, [
      { address: "GA_USER1", amount: 50, isYes: false, claimed: false },
    ]);

    upsertLeaderboardEntry("GA_USER1", 100, "won");
    upsertLeaderboardEntry("GA_USER2", 50, "lost");

    const stats = getPlatformStats();

    expect(stats.bets).toEqual({
      totalBets: 3,
      totalVolume: 350,
      uniqueBettors: 2,
      yesCount: 1,
      noCount: 2,
      yesVolume: 100,
      noVolume: 250,
      claimedCount: 1,
      unclaimedCount: 2,
    });

    expect(stats.leaderboard).toEqual({
      totalPoints: 150,
      totalWins: 1,
      totalLosses: 1,
      totalEntries: 2,
    });
  });
});
