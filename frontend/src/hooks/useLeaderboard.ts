"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getTopPlayers, getStats } from "@/services/leaderboard";
import { getMarkets, getMarketBettors } from "@/services/market";
import { getDisplayName } from "@/services/referral";
import type { PlayerStats } from "@/types";

export type LeaderboardTab = "top_predictors" | "most_active" | "top_referrers";

/** Auto-refresh interval (30 s) */
const POLL_INTERVAL = 30_000;

interface UseLeaderboardResult {
  data: PlayerStats[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Sort players based on the selected tab */
function sortByTab(players: PlayerStats[], tab: LeaderboardTab): PlayerStats[] {
  const sorted = [...players];
  switch (tab) {
    case "most_active":
      return sorted.sort((a, b) => b.totalBets - a.totalBets);
    case "top_referrers":
      return sorted.sort((a, b) => b.points - a.points);
    case "top_predictors":
    default:
      return sorted.sort((a, b) => b.points - a.points);
  }
}

/**
 * Fallback: build a leaderboard from market bettors when the
 * onchain top-players list is still empty (no claims/bonuses yet).
 */
async function buildFromMarketBettors(): Promise<PlayerStats[]> {
  try {
    const markets = await getMarkets();
    if (markets.length === 0) return [];

    // Collect unique addresses across all markets
    const addressSet = new Set<string>();
    const bettorResults = await Promise.allSettled(
      markets.map((m) => getMarketBettors(m.id))
    );
    for (const r of bettorResults) {
      if (r.status === "fulfilled") {
        for (const addr of r.value) addressSet.add(addr);
      }
    }
    if (addressSet.size === 0) return [];

    // For each unique bettor, fetch their leaderboard stats + display name
    const addresses = Array.from(addressSet);
    const results = await Promise.allSettled(
      addresses.map(async (addr) => {
        const [stats, name] = await Promise.all([
          getStats(addr),
          getDisplayName(addr).catch(() => ""),
        ]);
        return {
          address: addr,
          displayName: name || "",
          points: stats?.points ?? 0,
          totalBets: stats?.totalBets ?? 0,
          wonBets: stats?.wonBets ?? 0,
          lostBets: stats?.lostBets ?? 0,
          winRate: stats && stats.totalBets > 0
            ? (stats.wonBets / stats.totalBets) * 100
            : 0,
        } satisfies PlayerStats;
      })
    );
    return results
      .filter((r): r is PromiseFulfilledResult<PlayerStats> => r.status === "fulfilled")
      .map((r) => r.value);
  } catch {
    return [];
  }
}

export function useLeaderboard(
  tab?: LeaderboardTab
): UseLeaderboardResult {
  const [allPlayers, setAllPlayers] = useState<PlayerStats[]>([]);
  const [data, setData] = useState<PlayerStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const initialLoadDone = useRef(false);

  const fetchData = useCallback(async (silent = false) => {
    // Only show loading spinner on first load, not during polling
    if (!silent) setLoading(true);
    setError(null);
    try {
      let players = await getTopPlayers(50);

      // Fallback: if the onchain leaderboard is empty, construct from
      // market bettors (covers the period before any claim/bonus awards).
      if (players.length === 0) {
        players = await buildFromMarketBettors();
      }

      if (!mountedRef.current) return;
      setAllPlayers(players);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to load leaderboard"
      );
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        initialLoadDone.current = true;
      }
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData]);

  // Auto-poll every 30 seconds (silent — no skeleton flash)
  useEffect(() => {
    const interval = setInterval(() => {
      if (initialLoadDone.current) {
        fetchData(true);
      }
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Re-sort when tab or allPlayers changes
  useEffect(() => {
    setData(sortByTab(allPlayers, tab ?? "top_predictors"));
  }, [allPlayers, tab]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch };
}
