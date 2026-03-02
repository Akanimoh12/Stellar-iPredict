import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { LEADERBOARD_CONTRACT_ID, ADMIN_PUBLIC_KEY } from "@/config/network";
import { simulateTransaction } from "@/services/soroban";
import { getDisplayName } from "@/services/referral";
import * as cache from "@/services/cache";
import type { PlayerStats } from "@/types";

// ── Cache keys & TTLs ────────────────────────────────────────────────────────

const CACHE_TOP_PLAYERS = (limit: number) => `lb_top_${limit}`;
const CACHE_STATS = (addr: string) => `lb_stats_${addr}`;
const CACHE_POINTS = (addr: string) => `lb_pts_${addr}`;
const CACHE_RANK = (addr: string) => `lb_rank_${addr}`;

const LEADERBOARD_TTL = 60_000; // 60s
const STATS_TTL = 30_000; // 30s

/** Simulation source */
function simSource(): string {
  return ADMIN_PUBLIC_KEY;
}

function addressVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

function u32Val(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safely coerce to number, returning 0 for NaN/undefined/null */
function safe(v: unknown): number {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

// ── Raw contract return types ─────────────────────────────────────────────────

/** Contract struct PlayerEntry { address, points } — scValToNative returns an object */
interface RawPlayerEntry {
  address: string;
  points: number | bigint;
}

/** Contract struct PlayerStats { points, total_bets, won_bets, lost_bets } */
interface RawContractStats {
  points: number | bigint;
  total_bets: number | bigint;
  won_bets: number | bigint;
  lost_bets: number | bigint;
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

async function batchAll<T>(
  tasks: (() => Promise<T>)[],
  concurrency = 5
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency).map((fn) => fn());
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

// ── Read functions ────────────────────────────────────────────────────────────

/**
 * Get top N players from the leaderboard.
 * The contract returns Vec<PlayerEntry> where PlayerEntry is a struct
 * { address: Address, points: u64 }.  scValToNative deserialises this
 * as an array of plain JS objects.
 */
export async function getTopPlayers(limit: number): Promise<PlayerStats[]> {
  const cacheKey = CACHE_TOP_PLAYERS(limit);
  const cached = cache.get<PlayerStats[]>(cacheKey);
  if (cached) return cached;

  try {
    // Contract returns Vec<PlayerEntry> — each entry is { address, points }
    const raw = await simulateTransaction<RawPlayerEntry[]>(
      simSource(),
      LEADERBOARD_CONTRACT_ID,
      "get_top_players",
      [u32Val(limit)]
    );

    if (!raw || !Array.isArray(raw) || raw.length === 0) return [];

    // Normalise — handle both struct-objects and tuple-arrays (defensive)
    const entries: { addr: string; pts: number }[] = raw.map((item) => {
      if (Array.isArray(item)) {
        // Legacy/tuple form: [address, points]
        return { addr: String(item[0]), pts: safe(item[1]) };
      }
      // Struct form: { address, points }
      const obj = item as unknown as Record<string, unknown>;
      return {
        addr: String(obj.address ?? obj.addr ?? ""),
        pts: safe(obj.points ?? obj.pts ?? 0),
      };
    });

    // Batch-resolve display names with concurrency limit of 5
    const nameMap = new Map<string, string>();
    const nameTasks = entries.map(({ addr }) => async () => {
      try {
        const name = await getDisplayName(addr);
        nameMap.set(addr, name || "");
      } catch {
        nameMap.set(addr, "");
      }
    });
    await batchAll(nameTasks, 5);

    // Batch-fetch full stats for each player with concurrency limit of 5
    const statsTasks = entries.map(({ addr, pts }) => async () => {
      try {
        const statsRaw = await simulateTransaction<RawContractStats>(
          simSource(),
          LEADERBOARD_CONTRACT_ID,
          "get_stats",
          [addressVal(addr)]
        );

        const totalBets = parseContractStats(statsRaw, "total_bets");
        const wonBets = parseContractStats(statsRaw, "won_bets");
        const lostBets = parseContractStats(statsRaw, "lost_bets");

        return {
          address: addr,
          displayName: nameMap.get(addr) || "",
          points: pts,
          totalBets,
          wonBets,
          lostBets,
          winRate: totalBets > 0 ? (wonBets / totalBets) * 100 : 0,
        } satisfies PlayerStats;
      } catch {
        return {
          address: addr,
          displayName: nameMap.get(addr) || "",
          points: pts,
          totalBets: 0,
          wonBets: 0,
          lostBets: 0,
          winRate: 0,
        } satisfies PlayerStats;
      }
    });

    const players = await batchAll(statsTasks, 5);

    cache.set(cacheKey, players, LEADERBOARD_TTL);
    return players;
  } catch (err) {
    console.error("[iPredict] getTopPlayers error:", err);
    return [];
  }
}

/** Parse a field from a contract stats response — handles both struct and tuple */
function parseContractStats(raw: unknown, field: string): number {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return safe((raw as Record<string, unknown>)[field]);
  }
  // tuple fallback: [points, total_bets, won_bets, lost_bets]
  if (Array.isArray(raw)) {
    const idx = { points: 0, total_bets: 1, won_bets: 2, lost_bets: 3 }[field] ?? -1;
    return idx >= 0 ? safe(raw[idx]) : 0;
  }
  return 0;
}

/** Get stats for a specific user */
export async function getStats(
  userAddress: string
): Promise<PlayerStats | null> {
  const cacheKey = CACHE_STATS(userAddress);
  const cached = cache.get<PlayerStats>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await simulateTransaction<RawContractStats>(
      simSource(),
      LEADERBOARD_CONTRACT_ID,
      "get_stats",
      [addressVal(userAddress)]
    );

    const points = parseContractStats(raw, "points");
    const totalBets = parseContractStats(raw, "total_bets");
    const wonBets = parseContractStats(raw, "won_bets");
    const lostBets = parseContractStats(raw, "lost_bets");

    // Also resolve display name
    let displayName = "";
    try {
      displayName = await getDisplayName(userAddress);
    } catch {
      // silently fail
    }

    const stats: PlayerStats = {
      address: userAddress,
      displayName,
      points,
      totalBets,
      wonBets,
      lostBets,
      winRate: totalBets > 0 ? (wonBets / totalBets) * 100 : 0,
    };
    cache.set(cacheKey, stats, STATS_TTL);
    return stats;
  } catch {
    return null;
  }
}

/** Get total points for a user */
export async function getPoints(userAddress: string): Promise<number> {
  const cacheKey = CACHE_POINTS(userAddress);
  const cached = cache.get<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<number | bigint>(
      simSource(),
      LEADERBOARD_CONTRACT_ID,
      "get_points",
      [addressVal(userAddress)]
    );
    const pts = Number(raw);
    cache.set(cacheKey, pts, STATS_TTL);
    return pts;
  } catch {
    return 0;
  }
}

/** Get rank for a user (position in top players, or 0 if unranked) */
export async function getRank(userAddress: string): Promise<number> {
  const cacheKey = CACHE_RANK(userAddress);
  const cached = cache.get<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<number | bigint>(
      simSource(),
      LEADERBOARD_CONTRACT_ID,
      "get_rank",
      [addressVal(userAddress)]
    );
    const rank = Number(raw);
    cache.set(cacheKey, rank, LEADERBOARD_TTL);
    return rank;
  } catch {
    return 0;
  }
}
