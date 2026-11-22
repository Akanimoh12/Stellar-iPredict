"use client";

import { useState, useEffect, useRef } from "react";
import { API_BASE_URL } from "@/services/api";

export interface LiveMarketUpdate {
  marketId: number;
  totalYes: string | number;
  totalNo: string | number;
  totalPool: string | number;
  yesPercent: number;
  noPercent: number;
  betCount?: number;
  resolved?: boolean;
  outcome?: boolean | null;
  cancelled?: boolean;
  timestamp?: number;
}

export function useLiveMarketFeed(marketId?: number) {
  const [liveUpdate, setLiveUpdate] = useState<LiveMarketUpdate | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) {
      return;
    }

    const path = marketId ? `/api/markets/${marketId}/live` : "/api/markets/live";
    const url = `${API_BASE_URL}${path}`;

    try {
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnected(true);
      };

      const handleMessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data) as LiveMarketUpdate;
          if (!marketId || data.marketId === marketId) {
            setLiveUpdate(data);
          }
        } catch {
          // Ignore malformed heartbeats/comments
        }
      };

      es.addEventListener("market_update", handleMessage);
      es.addEventListener("market_snapshot", handleMessage);

      es.onerror = () => {
        setConnected(false);
      };

      return () => {
        es.removeEventListener("market_update", handleMessage);
        es.removeEventListener("market_snapshot", handleMessage);
        es.close();
        eventSourceRef.current = null;
        setConnected(false);
      };
    } catch {
      // Graceful fallback to polling when SSE is not accessible
      setConnected(false);
    }
  }, [marketId]);

  return { liveUpdate, connected };
}
