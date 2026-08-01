import { getAllBets } from "./bets.js";
import type { Bet } from "./bets.js";

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

export interface PlatformStats {
  bets: BetAggregates;
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

export function getPlatformStats(): PlatformStats {
  const allBets = getAllBets();
  return {
    bets: computeBetAggregates(allBets),
  };
}

/** Global statistics shape returned by the API. */
export interface GlobalStats {
  totalMarkets: number;
  volume: bigint;
  totalUsers: number;
  totalBets: number;
}

/**
 * Retrieves global statistics.
 * TODO: Replace with a real DB query once the stats table is populated.
 */
export async function getGlobalStats(): Promise<GlobalStats> {
  return {
    totalMarkets: 0,
    volume: BigInt(0),
    totalUsers: 0,
    totalBets: 0,
  };
}
