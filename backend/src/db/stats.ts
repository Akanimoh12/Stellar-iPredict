import { Pool } from "pg";
import { getAllBets } from "./bets.js";
import type { Bet } from "./bets.js";
import { getAllLeaderboardEntries, type LeaderboardEntry } from "./leaderboard.js";
import type { Queryable } from "./markets.js";

export type { Queryable };

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

/** Global statistics shape returned by the API and DB queries. */
export interface GlobalStats {
  totalMarkets: number;
  totalVolume: string;
  volume: bigint;
  totalUsers: number;
  totalBets: number;
}

export interface GlobalStatsRow {
  total_markets: string;
  total_volume: string;
  total_users: string;
  total_bets: string;
}

let pool: Pool | undefined;

function getDefaultDb(): Queryable {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  pool ??= new Pool({ connectionString });
  return pool;
}

export function setStatsDbPool(p: Pool): void {
  pool = p;
}

export const GLOBAL_STATS_QUERY = `SELECT (SELECT COUNT(*)::text FROM markets) AS total_markets,
  (SELECT COALESCE(SUM(total_yes + total_no), 0)::text FROM markets) AS total_volume,
  (SELECT COUNT(DISTINCT address)::text FROM leaderboard) AS total_users,
  (SELECT COUNT(*)::text FROM bets) AS total_bets;`;

/**
 * Retrieves global platform statistics aggregated from markets, bets, and leaderboard tables.
 */
export async function getGlobalStats(db?: Queryable): Promise<GlobalStats> {
  const executor = db ?? getDefaultDb();
  const { rows } = await executor.query<GlobalStatsRow>(GLOBAL_STATS_QUERY);
  const row = rows[0];

  const totalMarkets = Number(row?.total_markets ?? 0);
  const totalVolume = row?.total_volume ?? "0";
  const totalUsers = Number(row?.total_users ?? 0);
  const totalBets = Number(row?.total_bets ?? 0);

  let volume = 0n;
  try {
    const intPart = totalVolume.split(".")[0];
    volume = BigInt(intPart || "0");
  } catch {
    volume = 0n;
  }

  return {
    totalMarkets,
    totalVolume,
    volume,
    totalUsers,
    totalBets,
  };
}
