import { useEffect, useRef } from "react";

/**
 * Visibility-aware polling, backed by one shared scheduler.
 *
 * Problem this solves: a plain setInterval keeps firing RPC reads even when the
 * tab is in the background or the laptop is asleep. A single forgotten open tab
 * can generate hundreds of pointless requests per hour, which on a metered RPC
 * (QuickNode credits) burns real money for data nobody is looking at.
 *
 * Behaviour:
 *   • polling runs only while the document is VISIBLE; hidden tabs have no timers,
 *   • on becoming visible again, every subscriber refreshes once immediately (so
 *     the user sees fresh data the instant they return) and then resumes,
 *   • subscribers that share a cadence share ONE timer, so five hooks polling at
 *     the same interval cost one interval, not five,
 *   • the single visibilitychange listener is attached only while someone is
 *     subscribed.
 *
 * The callback should be "silent" (background refresh) — it must not flash a
 * loading skeleton, since the user already has data on screen.
 *
 * @param callback   the refresh function to run on each tick (kept in a ref so a
 *                   changing identity does not reset the timer)
 * @param intervalMs poll cadence while visible
 * @param enabled    gate polling on/off (e.g. only when a wallet is connected)
 */

type Subscriber = () => void;

interface Group {
  timer: ReturnType<typeof setInterval> | null;
  subs: Set<Subscriber>;
}

// One group per distinct interval. Module-level so every hook instance shares it.
const groups = new Map<number, Group>();
let listening = false;

const isVisible = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "visible";

function runGroup(group: Group): void {
  group.subs.forEach((fn) => fn());
}

function startGroup(intervalMs: number, group: Group): void {
  if (group.timer || group.subs.size === 0 || !isVisible()) return;
  group.timer = setInterval(() => runGroup(group), intervalMs);
}

function stopGroup(group: Group): void {
  if (group.timer) {
    clearInterval(group.timer);
    group.timer = null;
  }
}

function onVisibilityChange(): void {
  if (isVisible()) {
    // Refresh immediately on return, then resume ticking.
    groups.forEach((group, intervalMs) => {
      if (group.subs.size === 0) return;
      runGroup(group);
      startGroup(intervalMs, group);
    });
  } else {
    // Tab hidden — stop every timer. No requests while away.
    groups.forEach(stopGroup);
  }
}

function subscribe(intervalMs: number, fn: Subscriber): () => void {
  let group = groups.get(intervalMs);
  if (!group) {
    group = { timer: null, subs: new Set() };
    groups.set(intervalMs, group);
  }
  group.subs.add(fn);

  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    listening = true;
  }
  startGroup(intervalMs, group);

  return () => {
    const current = groups.get(intervalMs);
    if (!current) return;
    current.subs.delete(fn);
    if (current.subs.size === 0) {
      stopGroup(current);
      groups.delete(intervalMs);
    }
    if (groups.size === 0 && listening) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      listening = false;
    }
  };
}

export function useVisiblePoll(
  callback: () => void,
  intervalMs: number,
  enabled = true
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    return subscribe(intervalMs, () => cbRef.current());
  }, [intervalMs, enabled]);
}

/** Test-only: number of distinct shared timers currently registered. */
export const __schedulerGroupCountForTests = () => groups.size;
