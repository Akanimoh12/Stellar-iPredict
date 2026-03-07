"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getStats } from "@/services/leaderboard";
import { getBalance } from "@/services/token";
import {
  getReferrer,
  getDisplayName,
  getReferralCount,
  getEarnings,
  isRegistered,
} from "@/services/referral";
import type { PlayerStats, ReferralInfo } from "@/types";

/** Auto-refresh interval (30 s) */
const POLL_INTERVAL = 30_000;

interface ProfileData {
  stats: PlayerStats | null;
  referral: ReferralInfo | null;
  tokenBalance: number;
}

interface UseProfileResult {
  data: ProfileData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useProfile(publicKey?: string): UseProfileResult {
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const initialLoadDone = useRef(false);

  const fetchData = useCallback(async (silent = false) => {
    if (!publicKey) {
      setData(null);
      setLoading(false);
      return;
    }

    // Only show loading skeleton if we have no data yet (first load)
    if (!silent && !initialLoadDone.current) setLoading(true);
    setError(null);
    try {
      // Fetch all data in parallel
      const [
        stats,
        tokenBalance,
        referrer,
        displayName,
        referralCount,
        earnings,
        registered,
      ] = await Promise.all([
        getStats(publicKey),
        getBalance(publicKey),
        getReferrer(publicKey),
        getDisplayName(publicKey),
        getReferralCount(publicKey),
        getEarnings(publicKey),
        isRegistered(publicKey),
      ]);

      if (!mountedRef.current) return;

      const referral: ReferralInfo = {
        referrer,
        displayName,
        referralCount,
        earnings,
        isRegistered: registered,
      };

      setData({ stats, referral, tokenBalance });
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to load profile"
      );
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        initialLoadDone.current = true;
      }
    }
  }, [publicKey]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData]);

  // Auto-poll every 30 seconds (silent — update values without re-rendering skeleton)
  useEffect(() => {
    if (!publicKey) return;
    const interval = setInterval(() => {
      if (initialLoadDone.current) {
        fetchData(true);
      }
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData, publicKey]);

  const refetch = useCallback(() => {
    fetchData(true); // Always silent on manual refetch (data already visible)
  }, [fetchData]);

  return { data, loading, error, refetch };
}
