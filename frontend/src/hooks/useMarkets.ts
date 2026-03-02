"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getMarkets } from "@/services/market";
import type { Market, MarketFilter, MarketSort } from "@/types";

// ── Ending-soon threshold: markets expiring within 24 hours ───────────────────
const ENDING_SOON_MS = 24 * 60 * 60 * 1000;

interface UseMarketsResult {
  data: Market[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Apply client-side filter to markets */
function applyFilter(markets: Market[], filter: MarketFilter): Market[] {
  const now = Date.now();
  switch (filter) {
    case "active":
      return markets.filter(
        (m) => !m.resolved && !m.cancelled && m.endTime * 1000 > now
      );
    case "ending_soon":
      return markets.filter(
        (m) =>
          !m.resolved &&
          !m.cancelled &&
          m.endTime * 1000 > now &&
          m.endTime * 1000 - now < ENDING_SOON_MS
      );
    case "resolved":
      return markets.filter((m) => m.resolved);
    case "cancelled":
      return markets.filter((m) => m.cancelled);
    case "all":
    default:
      return markets;
  }
}

/** Apply client-side sort to markets */
function applySort(markets: Market[], sort: MarketSort): Market[] {
  const sorted = [...markets];
  switch (sort) {
    case "newest":
      return sorted.sort((a, b) => b.id - a.id);
    case "volume":
      return sorted.sort(
        (a, b) => b.totalYes + b.totalNo - (a.totalYes + a.totalNo)
      );
    case "ending_soon":
      return sorted.sort((a, b) => a.endTime - b.endTime);
    case "bettors":
      return sorted.sort((a, b) => b.betCount - a.betCount);
    default:
      return sorted;
  }
}

export function useMarkets(
  filter?: MarketFilter,
  sort?: MarketSort
): UseMarketsResult {
  const [allMarkets, setAllMarkets] = useState<Market[]>([]);
  const [data, setData] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchMarkets = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const markets = await getMarkets();
      if (!mountedRef.current) return;
      setAllMarkets(markets);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to load markets"
      );
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    mountedRef.current = true;
    fetchMarkets();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchMarkets]);

  // Auto-poll every 30 seconds (silent refresh — no skeleton flash)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMarkets(true);
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  // Re-apply filter/sort when allMarkets, filter, or sort changes
  useEffect(() => {
    let result = applyFilter(allMarkets, filter ?? "all");
    result = applySort(result, sort ?? "newest");
    setData(result);
  }, [allMarkets, filter, sort]);

  const refetch = useCallback(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  return { data, loading, error, refetch };
}
