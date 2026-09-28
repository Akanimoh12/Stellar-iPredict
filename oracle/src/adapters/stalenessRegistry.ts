/**
 * Process-wide registry of adapter quote freshness.
 *
 * The aggregator resolves prices in one call site and the monitor alerts from
 * another; without a shared holder each would have to be handed the other's
 * state. Every adapter reports the status of the quote it just processed here,
 * and `staleAdapterReports()` is what alerting and the health endpoint read.
 *
 * The registry is intentionally a plain module singleton rather than a
 * dependency-injected service: it holds no secrets, no I/O, and no request
 * state — only a bounded window of timestamps and statuses. Tests that need
 * isolation call {@link resetStalenessRegistry}.
 */

import { StalenessTracker, type AdapterStalenessReport, type QuoteStatus, type StalenessTrackerOptions } from "./freshness.js";

/** Process-wide tracker. Replaced wholesale by tests via {@link setStalenessTracker}. */
let tracker = new StalenessTracker();

/**
 * Records the freshness status of one resolved quote.
 *
 * Cheap and synchronous on purpose: adapters call it on every resolution, so
 * it must not add a network hop, and it must not throw — a monitoring
 * bookkeeping failure should never cost a market its resolution.
 */
export function recordQuoteStatus(adapterId: string, status: QuoteStatus, at: number = Date.now()): void {
  try {
    tracker.record(adapterId, status, at);
  } catch {
    // Deliberately swallowed; see the doc comment.
  }
}

/** Adapters currently showing sustained non-freshness, worst first. */
export function staleAdapterReports(now: number = Date.now()): AdapterStalenessReport[] {
  try {
    return tracker.evaluate(now);
  } catch {
    return [];
  }
}

/** Replaces the process tracker. Intended for tests and for a monitor that
 *  wants to widen the window from configuration. */
export function setStalenessTracker(next: StalenessTracker): void {
  tracker = next;
}

/** The active tracker, for inspection. */
export function getStalenessTracker(): StalenessTracker {
  return tracker;
}

/** Clears all recorded observations. Intended for tests. */
export function resetStalenessRegistry(options: StalenessTrackerOptions = {}): StalenessTracker {
  tracker = new StalenessTracker(options);
  return tracker;
}

/**
 * One staleness alert, shaped for the monitor's webhook.
 *
 * The `status` field distinguishes the two cases an operator must not
 * confuse: `untimestamped` means the provider never tells us how old its
 * numbers are (a permanent, documented limitation — fix the mapping or accept
 * the downweight), whereas `stale`/`expired` means it *did* tell us and the
 * answer was too old, which points at a caching or outage problem upstream.
 */
export interface StaleDataAlert {
  adapterId: string;
  status: "untimestamped" | "stale" | "expired";
  notFresh: number;
  total: number;
  ratio: number;
  consecutiveNotFreshMs: number;
  windowFullyNotFresh: boolean;
  /** Operator-facing next step. Never names a credential. */
  message: string;
}

function alertStatus(worst: QuoteStatus): StaleDataAlert["status"] {
  if (worst === "expired" || worst === "stale") return worst;
  return "untimestamped";
}

/**
 * Converts the current staleness picture into alert payloads.
 *
 * `windowFullyNotFresh` is called out separately in the message because it is
 * the case that cannot be explained away as a slow poll: every single sample
 * in the window was unusable.
 */
export function staleDataAlerts(now: number = Date.now()): StaleDataAlert[] {
  return staleAdapterReports(now).map((report) => {
    const status = alertStatus(report.worstStatus);
    const minutes = Math.round(report.consecutiveNotFreshMs / 60_000);
    const message = report.windowFullyNotFresh
      ? `Adapter "${report.adapterId}" returned no fresh quote in its entire ${minutes}m window ` +
        `(${report.notFresh}/${report.total} not fresh, worst ${status}). Markets relying on it are ` +
        `resolving against downweighted or unverifiable data.`
      : `Adapter "${report.adapterId}" has been not-fresh for ${minutes}m ` +
        `(${report.notFresh}/${report.total} samples, worst ${status}).`;

    return {
      adapterId: report.adapterId,
      status,
      notFresh: report.notFresh,
      total: report.total,
      ratio: report.ratio,
      consecutiveNotFreshMs: report.consecutiveNotFreshMs,
      windowFullyNotFresh: report.windowFullyNotFresh,
      message,
    };
  });
}
