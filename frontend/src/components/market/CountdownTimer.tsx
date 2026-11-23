"use client";

import React, { useState, useEffect } from "react";
import { FiClock } from "react-icons/fi";

interface CountdownTimerProps {
  endTime: number;
}

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "Ended";

  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Seconds left until `endTime` (unix seconds), measured against the wall clock. */
function secondsUntil(endTime: number, nowMs: number): number {
  return Math.max(0, endTime - Math.floor(nowMs / 1000));
}

/**
 * Countdown that is derived from `endTime` on every tick, never from a count of
 * ticks. Browsers throttle timers in background tabs (often to once a minute),
 * so an accumulated countdown would drift or freeze. Each tick re-reads the wall
 * clock, and the tick also fires immediately when the tab becomes visible again.
 */
export default function CountdownTimer({ endTime }: CountdownTimerProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const remaining = secondsUntil(endTime, nowMs);

  // Tick every second in the final hour, every minute otherwise. The effect
  // depends on the two derived flags, so the timer is re-created only when the
  // countdown crosses the one-hour threshold or ends.
  const isUrgent = remaining > 0 && remaining <= 3600;
  const isEnded = remaining <= 0;

  useEffect(() => {
    if (isEnded) return;

    const sync = () => setNowMs(Date.now());
    sync();

    const id = setInterval(sync, isUrgent ? 1000 : 60_000);
    document.addEventListener("visibilitychange", sync);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [endTime, isUrgent, isEnded]);

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm font-medium ${
        isEnded
          ? "text-accent-red"
          : isUrgent
            ? "text-accent-red animate-pulse"
            : "text-slate-400"
      }`}
    >
      <FiClock className="w-3.5 h-3.5" />
      {formatRemaining(remaining)}
    </span>
  );
}
