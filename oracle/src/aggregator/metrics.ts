/**
 * Tracks aggregator performance metrics — primarily the lag between a
 * market's expiry (`endTime`) and its actual resolution timestamp.
 *
 * All timestamps are Unix seconds.
 *
 * ## Named metric: oracle_resolution_lag_h
 *
 * The canonical metric name for resolution lag is `oracle_resolution_lag_h`.
 * Use `serializeMetric()` to obtain a Prometheus-compatible text line, or
 * `getMetric()` to retrieve the current value by name.
 *
 * ```ts
 * const metrics = new AggregatorMetrics();
 * metrics.recordResolution(marketId, endTime, resolvedAt);
 * console.log(metrics.serializeMetric(ORACLE_RESOLUTION_LAG_H_METRIC));
 * // oracle_resolution_lag_h{market_id="42"} 2.5
 * ```
 */

/** Canonical Prometheus-style metric name for resolution lag in hours. */
export const ORACLE_RESOLUTION_LAG_H_METRIC = "oracle_resolution_lag_h" as const;

/**
 * Canonical metric name for how long the aggregator has been unable to
 * complete a poll cycle. `0` while healthy. Issue #645.
 */
export const ORACLE_AGGREGATOR_UNAVAILABLE_SECONDS_METRIC =
  "oracle_aggregator_unavailable_seconds" as const;

/** Health level derived from how long the aggregator has been stalled. */
export type AggregatorAvailabilityLevel = "ok" | "degraded" | "critical";

export interface AggregatorAvailability {
  /** `true` while the last successful poll is within `degradedAfterMs`. */
  available: boolean;
  /** Epoch ms of the last completed poll, or `null` if none yet. */
  lastPollCompletedAt: number | null;
  /** ms since the last completed poll, or `null` if none yet. */
  sinceLastPollMs: number | null;
  /** Consecutive failed poll attempts since the last success. */
  consecutiveFailures: number;
  level: AggregatorAvailabilityLevel;
  /** `true` once the stall has exceeded `degradedAfterMs`. */
  degraded: boolean;
  /**
   * `true` once the stall has exceeded `alertAfterMs` — sustained
   * unavailability that operators must be paged about.
   */
  shouldAlert: boolean;
}

export interface AssessAggregatorAvailabilityInput {
  lastPollCompletedAt: number | null;
  /** "now" in epoch ms. */
  now: number;
  consecutiveFailures?: number;
  /** Stall beyond this (ms) is degraded. Default 15 min. */
  degradedAfterMs?: number;
  /** Stall beyond this (ms) alerts. Default 60 min. */
  alertAfterMs?: number;
}

const DEFAULT_DEGRADED_AFTER_MS = 15 * 60_000;
const DEFAULT_ALERT_AFTER_MS = 60 * 60_000;

/**
 * Pure assessment of aggregator availability from its last successful poll.
 *
 * The backend cannot see the aggregator process directly; it infers the same
 * condition from unresolved-but-overdue markets. This function is the shared
 * definition of "how stale is too stale" so both sides agree. Issue #645.
 */
export function assessAggregatorAvailability(
  input: AssessAggregatorAvailabilityInput,
): AggregatorAvailability {
  const degradedAfterMs = input.degradedAfterMs ?? DEFAULT_DEGRADED_AFTER_MS;
  const alertAfterMs = input.alertAfterMs ?? DEFAULT_ALERT_AFTER_MS;
  const consecutiveFailures = input.consecutiveFailures ?? 0;

  const sinceLastPollMs =
    input.lastPollCompletedAt === null
      ? null
      : Math.max(0, input.now - input.lastPollCompletedAt);

  // No poll has ever completed — treat as unavailable from process start.
  const stalledMs = sinceLastPollMs ?? Number.POSITIVE_INFINITY;
  const degraded = stalledMs > degradedAfterMs;
  const shouldAlert = stalledMs > alertAfterMs;
  const level: AggregatorAvailabilityLevel = shouldAlert
    ? "critical"
    : degraded
      ? "degraded"
      : "ok";

  return {
    available: !degraded,
    lastPollCompletedAt: input.lastPollCompletedAt,
    sinceLastPollMs,
    consecutiveFailures,
    level,
    degraded,
    shouldAlert,
  };
}

export interface ResolutionLagEntry {
  marketId: string;
  endTime: number;
  resolvedAt: number;
  /** Hours from expiry to resolution (negative if resolved before expiry). */
  lagHours: number;
}

export interface AggregatorMetricsSnapshot {
  /** Total markets that have been resolved through the aggregator. */
  totalResolved: number;
  /** Total number of oracle submissions. */
  totalSubmissions: number;
  /** Total number of oracle disputes (escalated markets). */
  totalDisputes: number;
  /** Average resolution lag in hours across all resolved markets. */
  averageLagHours: number;
  /** Maximum resolution lag in hours (worst case). */
  maxLagHours: number;
  /** Minimum resolution lag in hours (best case). */
  minLagHours: number;
  /** Individual entries, most recent first. */
  entries: readonly ResolutionLagEntry[];
}

/**
 * A single named metric value, keyed by `ORACLE_RESOLUTION_LAG_H_METRIC`.
 * Returned by `AggregatorMetrics.getMetric()`.
 */
export interface NamedMetric {
  /** Canonical metric name, e.g. `"oracle_resolution_lag_h"`. */
  name: typeof ORACLE_RESOLUTION_LAG_H_METRIC;
  /** Market ID this observation belongs to. */
  marketId: string;
  /** Lag value in hours (seconds-precision float). */
  value: number;
}

export class AggregatorMetrics {
  private readonly entries: ResolutionLagEntry[] = [];
  private _totalSubmissions = 0;
  private _totalDisputes = 0;
  private _lastPollCompletedAt: number | null = null;
  private _consecutivePollFailures = 0;

  /**
   * Record a resolution event and return a `NamedMetric` for
   * `oracle_resolution_lag_h` alongside the raw entry.
   *
   * @param marketId   - unique market identifier
   * @param endTime    - market expiry Unix timestamp (seconds)
   * @param resolvedAt - moment the resolution was confirmed on-chain (seconds)
   */
  recordResolution(
    marketId: string,
    endTime: number,
    resolvedAt: number,
  ): ResolutionLagEntry {
    const lagSeconds = resolvedAt - endTime;
    const lagHours = lagSeconds / 3_600;
    const entry: ResolutionLagEntry = { marketId, endTime, resolvedAt, lagHours };
    this.entries.push(entry);
    return entry;
  }

  /** Record a new submission event. */
  recordSubmission(): void {
    this._totalSubmissions += 1;
  }

  /** Record a new dispute (escalated market) event. */
  recordDispute(): void {
    this._totalDisputes += 1;
  }

  /**
   * Record a poll cycle that completed. Clears the failure streak and is the
   * heartbeat `assessAggregatorAvailability()` measures staleness against.
   */
  recordPollCompleted(atMs: number = Date.now()): void {
    this._lastPollCompletedAt = atMs;
    this._consecutivePollFailures = 0;
  }

  /** Record a poll cycle that threw before completing. */
  recordPollFailure(): void {
    this._consecutivePollFailures += 1;
  }

  /** Epoch ms of the last completed poll cycle, or `null` if none yet. */
  get lastPollCompletedAt(): number | null {
    return this._lastPollCompletedAt;
  }

  /**
   * Current availability assessment. `now` and the thresholds are injected so
   * this stays testable and matches the backend's overdue-market heuristic.
   * Issue #645.
   */
  availability(
    nowMs: number = Date.now(),
    opts: { degradedAfterMs?: number; alertAfterMs?: number } = {},
  ): AggregatorAvailability {
    return assessAggregatorAvailability({
      lastPollCompletedAt: this._lastPollCompletedAt,
      now: nowMs,
      consecutiveFailures: this._consecutivePollFailures,
      degradedAfterMs: opts.degradedAfterMs,
      alertAfterMs: opts.alertAfterMs,
    });
  }

  /**
   * Prometheus text lines for the aggregator-availability gauges. Pair with the
   * `oracle_aggregator_unavailable_seconds` alert rule (see
   * `docs/DEPLOYMENT-GUIDE.md` § "Oracle aggregator outage").
   */
  serializeAvailability(
    nowMs: number = Date.now(),
    opts: { degradedAfterMs?: number; alertAfterMs?: number } = {},
  ): string[] {
    const a = this.availability(nowMs, opts);
    // Seconds stalled once degraded; 0 while healthy so the gauge is a clean
    // "how long has this been broken" signal for alerting.
    const unavailableSeconds =
      a.degraded && a.sinceLastPollMs !== null ? a.sinceLastPollMs / 1_000 : 0;
    return [
      `${ORACLE_AGGREGATOR_UNAVAILABLE_SECONDS_METRIC} ${unavailableSeconds}`,
      `oracle_aggregator_available ${a.available ? 1 : 0}`,
      `oracle_aggregator_consecutive_poll_failures ${a.consecutiveFailures}`,
    ];
  }

  /**
   * Return the latest `oracle_resolution_lag_h` metric for a given market,
   * or `null` if no resolution has been recorded for it yet.
   *
   * @param name     - must be `ORACLE_RESOLUTION_LAG_H_METRIC`
   * @param marketId - market to look up
   */
  getMetric(
    name: typeof ORACLE_RESOLUTION_LAG_H_METRIC,
    marketId: string,
  ): NamedMetric | null {
    // Walk backwards to return the most recent entry for this market.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.marketId === marketId) {
        return { name, marketId, value: entry.lagHours };
      }
    }
    return null;
  }

  /**
   * Serialize the most recent `oracle_resolution_lag_h` observation for
   * `marketId` as a Prometheus text-format line.
   *
   * Returns `null` when no resolution has been recorded for that market.
   *
   * Example output:
   * ```
   * oracle_resolution_lag_h{market_id="42"} 2.5
   * ```
   *
   * @param name     - must be `ORACLE_RESOLUTION_LAG_H_METRIC`
   * @param marketId - market to serialize
   */
  serializeMetric(
    name: typeof ORACLE_RESOLUTION_LAG_H_METRIC,
    marketId: string,
  ): string | null {
    const metric = this.getMetric(name, marketId);
    if (!metric) return null;
    return `${metric.name}{market_id="${metric.marketId}"} ${metric.value}`;
  }

  /**
   * Return all recorded `oracle_resolution_lag_h` observations as
   * Prometheus text-format lines, newest-first.
   *
   * Useful for exposing a `/metrics` endpoint.
   */
  serializeAll(name: typeof ORACLE_RESOLUTION_LAG_H_METRIC): string[] {
    return [...this.entries]
      .reverse()
      .map((e) => `${name}{market_id="${e.marketId}"} ${e.lagHours}`);
  }

  /** Build a snapshot of all collected metrics. */
  snapshot(): AggregatorMetricsSnapshot {
    if (this.entries.length === 0) {
      return {
        totalResolved: 0,
        totalSubmissions: this._totalSubmissions,
        totalDisputes: this._totalDisputes,
        averageLagHours: 0,
        maxLagHours: 0,
        minLagHours: 0,
        entries: [],
      };
    }

    let sum = 0;
    let max = -Infinity;
    let min = Infinity;

    for (const entry of this.entries) {
      sum += entry.lagHours;
      if (entry.lagHours > max) max = entry.lagHours;
      if (entry.lagHours < min) min = entry.lagHours;
    }

    return {
      totalResolved: this.entries.length,
      totalSubmissions: this._totalSubmissions,
      totalDisputes: this._totalDisputes,
      averageLagHours: sum / this.entries.length,
      maxLagHours: max,
      minLagHours: min,
      entries: [...this.entries].reverse(),
    };
  }

  /** Number of resolutions recorded. */
  get totalResolved(): number {
    return this.entries.length;
  }

  /** Reset all recorded metrics. */
  reset(): void {
    this.entries.length = 0;
    this._totalSubmissions = 0;
    this._totalDisputes = 0;
  }
}
