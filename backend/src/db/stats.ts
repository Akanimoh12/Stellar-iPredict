import { getAllBets } from "@/db/bets";
import { getAllLeaderboardEntries } from "@/db/leaderboard";
import type { Bet } from "@/db/bets";
import type { LeaderboardEntry } from "@/db/leaderboard";

export interface BetAggregates {
  totalBets: number;
  totalVolume: number;
  uniqueBettors: number;
  yesCount: number;
  noCount: number;
  yesVolume: number;
  noVolume: number;
  claimedCount: number;
  unclaimedCount: number;
}

export interface LeaderboardAggregates {
  totalPoints: number;
  totalWins: number;
  totalLosses: number;
  totalEntries: number;
}

export interface PlatformStats {
  bets: BetAggregates;
  leaderboard: LeaderboardAggregates;
}

function computeBetAggregates(bets: { marketId: number; bet: Bet }[]): BetAggregates {
  let totalVolume = 0;
  let yesCount = 0;
  let noCount = 0;
  let yesVolume = 0;
  let noVolume = 0;
  let claimedCount = 0;
  let unclaimedCount = 0;
  const bettors = new Set<string>();

  for (const { bet } of bets) {
    totalVolume += bet.amount;
    bettors.add(bet.address);

    if (bet.isYes) {
      yesCount++;
      yesVolume += bet.amount;
    } else {
      noCount++;
      noVolume += bet.amount;
    }

    if (bet.claimed) {
      claimedCount++;
    } else {
      unclaimedCount++;
    }
  }

  return {
    totalBets: bets.length,
    totalVolume,
    uniqueBettors: bettors.size,
    yesCount,
    noCount,
    yesVolume,
    noVolume,
    claimedCount,
    unclaimedCount,
  };
}

function computeLeaderboardAggregates(entries: LeaderboardEntry[]): LeaderboardAggregates {
  let totalPoints = 0;
  let totalWins = 0;
  let totalLosses = 0;

  for (const entry of entries) {
    totalPoints += entry.points;
    totalWins += entry.won;
    totalLosses += entry.lost;
  }

  return {
    totalPoints,
    totalWins,
    totalLosses,
    totalEntries: entries.length,
  };
}

export function getPlatformStats(): PlatformStats {
  const allBets = getAllBets();
  const allEntries = getAllLeaderboardEntries();

  return {
    bets: computeBetAggregates(allBets),
    leaderboard: computeLeaderboardAggregates(allEntries),
  };
}
