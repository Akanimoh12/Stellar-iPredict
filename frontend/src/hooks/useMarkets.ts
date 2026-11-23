"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getMarkets } from "@/services/market";
import * as cache from "@/services/cache";
import { useVisiblePoll } from "@/hooks/useVisiblePoll";
import type { Market, MarketFilter, MarketSort } from "@/types";

// ── Ending-soon threshold: markets expiring within 24 hours ───────────────────
const ENDING_SOON_MS = 24 * 60 * 60 * 1000;

// Poll cadence while the tab is visible. 90s (was 30s) — markets change on the
// timescale of bets, not seconds, so this is plenty fresh while cutting idle
// RPC load 3x. Polling fully pauses when the tab is hidden (useVisiblePoll).
const POLL_INTERVAL = 90_000;

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
    case "ended":
      return markets.filter(
        (m) => !m.resolved && !m.cancelled && m.endTime * 1000 <= now
      );
    case "resolved":
      return markets.filter((m) => m.resolved);
    case "cancelled":
      return markets.filter((m) => m.cancelled);
    // Category filters
    case "crypto":
      return markets.filter((m) => m.category === "Crypto");
    case "sports":
      return markets.filter((m) => m.category === "Sports");
    case "politics":
      return markets.filter((m) => m.category === "Politics");
    case "entertainment":
      return markets.filter((m) => m.category === "Entertainment");
    case "science":
      return markets.filter((m) => m.category === "Science");
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
  // Seed from STALE cache so returning to /markets shows data instantly,
  // then refresh in the background (stale-while-revalidate).
  const cachedMarkets = useRef(cache.getStale<Market[]>("markets"));
  const [allMarkets, setAllMarkets] = useState<Market[]>(cachedMarkets.current ?? []);
  const [data, setData] = useState<Market[]>([]);
  const [loading, setLoading] = useState(!cachedMarkets.current);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const hasMarketsRef = useRef(cachedMarkets.current !== null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const filterReadyRef = useRef(false);

  const fetchMarkets = useCallback(async (silent = false) => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    if (!silent && !hasMarketsRef.current) setLoading(true);
    setError(null);
    try {
      const markets = await getMarkets(controller.signal);
      if (controller.signal.aborted) return;
      if (!mountedRef.current) return;
      setAllMarkets(markets);
      hasMarketsRef.current = markets.length > 0;
    } catch (err) {
      if (controller.signal.aborted) return;
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to load markets"
      );
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  // Fetch on mount — silent (background refresh) if we already have stale data,
  // so returning to the page never flashes a skeleton.
  useEffect(() => {
    mountedRef.current = true;
    fetchMarkets(cachedMarkets.current !== null && cachedMarkets.current.length > 0);
    return () => {
      mountedRef.current = false;
      requestControllerRef.current?.abort();
    };
  }, [fetchMarkets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter and sort changes are local operations, but refreshing through the
  // RPC-backed market service is debounced and the previous refresh is aborted.
  useEffect(() => {
    if (!filterReadyRef.current) {
      filterReadyRef.current = true;
      return;
    }

    const timeout = window.setTimeout(() => {
      fetchMarkets(true);
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      requestControllerRef.current?.abort();
    };
  }, [filter, sort, fetchMarkets]);

  // Auto-poll while visible (silent refresh — no skeleton flash). Pauses
  // entirely when the tab is hidden, so a forgotten open tab costs nothing.
  useVisiblePoll(() => fetchMarkets(true), POLL_INTERVAL);

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
