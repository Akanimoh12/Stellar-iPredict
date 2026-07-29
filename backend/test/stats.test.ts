import { describe, it, expect, beforeEach } from "vitest";
import { seedBets, clearBets } from "@/db/bets";
import {
  upsertLeaderboardEntry,
  clearLeaderboard,
} from "@/db/leaderboard";
import { getPlatformStats, type PlatformStats } from "@/db/stats";

function emptyStats(): PlatformStats {
  return {
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
  };
}

describe("getPlatformStats", () => {
  beforeEach(() => {
    clearBets();
    clearLeaderboard();
  });

  it("returns empty stats when no data exists", () => {
    expect(getPlatformStats()).toEqual(emptyStats());
  });

  it("aggregates bets from a single market", () => {
    seedBets(1, [
      { address: "GAA", amount: 100, isYes: true, claimed: false },
      { address: "GBB", amount: 200, isYes: false, claimed: true },
    ]);

    const stats = getPlatformStats();

    expect(stats.bets).toEqual({
      totalBets: 2,
      totalVolume: 300,
      uniqueBettors: 2,
      yesCount: 1,
      noCount: 1,
      yesVolume: 100,
      noVolume: 200,
      claimedCount: 1,
      unclaimedCount: 1,
    });
  });

  it("aggregates bets across multiple markets", () => {
    seedBets(1, [
      { address: "GAA", amount: 50, isYes: true, claimed: false },
    ]);
    seedBets(2, [
      { address: "GBB", amount: 150, isYes: false, claimed: true },
      { address: "GCC", amount: 75, isYes: true, claimed: false },
    ]);

    const stats = getPlatformStats();

    expect(stats.bets.totalBets).toBe(3);
    expect(stats.bets.totalVolume).toBe(275);
    expect(stats.bets.uniqueBettors).toBe(3);
    expect(stats.bets.yesCount).toBe(2);
    expect(stats.bets.noCount).toBe(1);
    expect(stats.bets.yesVolume).toBe(125);
    expect(stats.bets.noVolume).toBe(150);
    expect(stats.bets.claimedCount).toBe(1);
    expect(stats.bets.unclaimedCount).toBe(2);
  });

  it("counts unique bettors across markets", () => {
    seedBets(1, [
      { address: "GAA", amount: 10, isYes: true, claimed: false },
      { address: "GBB", amount: 20, isYes: false, claimed: true },
    ]);
    seedBets(2, [
      { address: "GAA", amount: 30, isYes: false, claimed: true },
      { address: "GCC", amount: 40, isYes: true, claimed: false },
    ]);

    const stats = getPlatformStats();

    expect(stats.bets.totalBets).toBe(4);
    expect(stats.bets.totalVolume).toBe(100);
    expect(stats.bets.uniqueBettors).toBe(3);
  });

  it("aggregates leaderboard stats with no entries", () => {
    const stats = getPlatformStats();
    expect(stats.leaderboard).toEqual({
      totalPoints: 0,
      totalWins: 0,
      totalLosses: 0,
      totalEntries: 0,
    });
  });

  it("aggregates leaderboard entries", () => {
    upsertLeaderboardEntry("GAA", 100, "won");
    upsertLeaderboardEntry("GBB", 50, "won");
    upsertLeaderboardEntry("GBB", 30, "lost");
    upsertLeaderboardEntry("GCC", 20, "lost");

    const stats = getPlatformStats();

    expect(stats.leaderboard).toEqual({
      totalPoints: 200,
      totalWins: 2,
      totalLosses: 2,
      totalEntries: 3,
    });
  });

  it("combines bet and leaderboard aggregates", () => {
    seedBets(1, [
      { address: "GAA", amount: 100, isYes: true, claimed: false },
      { address: "GBB", amount: 200, isYes: false, claimed: true },
    ]);
    upsertLeaderboardEntry("GAA", 50, "won");
    upsertLeaderboardEntry("GBB", 30, "lost");

    const stats = getPlatformStats();

    expect(stats.bets.totalBets).toBe(2);
    expect(stats.bets.totalVolume).toBe(300);
    expect(stats.leaderboard.totalPoints).toBe(80);
    expect(stats.leaderboard.totalEntries).toBe(2);
  });

  it("correctly computes yes/no volumes with zero amounts", () => {
    seedBets(1, [
      { address: "GAA", amount: 0, isYes: true, claimed: false },
      { address: "GBB", amount: 0, isYes: false, claimed: false },
    ]);

    const stats = getPlatformStats();

    expect(stats.bets.yesVolume).toBe(0);
    expect(stats.bets.noVolume).toBe(0);
    expect(stats.bets.totalVolume).toBe(0);
    expect(stats.bets.totalBets).toBe(2);
  });

  it("handles leaderboard with zero-point entries", () => {
    upsertLeaderboardEntry("GAA", 0, "won");
    upsertLeaderboardEntry("GBB", 0, "lost");

    const stats = getPlatformStats();

    expect(stats.leaderboard.totalPoints).toBe(0);
    expect(stats.leaderboard.totalWins).toBe(1);
    expect(stats.leaderboard.totalLosses).toBe(1);
    expect(stats.leaderboard.totalEntries).toBe(2);
  });
});
