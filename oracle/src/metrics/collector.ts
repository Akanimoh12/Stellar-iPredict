/**
 * Reads the oracle's Prometheus metrics out of Postgres — issue #211.
 *
 * ## Why Postgres and not in-process counters
 *
 * `AggregatorMetrics` (`../aggregator/metrics.ts`) is an in-process registry:
 * it counts what *this* process observed since *this* process started. That is
 * the wrong shape for `oracle_submissions_total` and `oracle_disputes_total`,
 * because submissions arrive through the API and the challenge bot as well as
 * the aggregator, and because a restart would reset every counter to zero
 * while the underlying rows are still there.
 *
 * Postgres already holds the whole picture (`oracle_submissions`,
 * `oracle_disputes`), so the collector reads the totals from there. The
 * numbers are then correct across restarts and independent of which process
 * happened to handle a given submission — Prometheus `rate()` over a counter
 * that resets on deploy is exactly the alerting bug this avoids.
 *
 * ## Resolution lag
 *
 * There is no `markets.resolved_at` column. `oracle_submissions.finalized_at`
 * (added in `db/migrations/0011_extend_oracle_submissions.sql`) is the moment
 * the decision was recorded, and `markets.end_time` is the expiry, so lag is
 * the difference between them. This matches `AggregatorMetrics.recordResolution`,
 * which computes the same quantity in-process for a single finalization.
 */

import type { QueryablePool } from "../aggregator/tally.js";

/** One `oracle_resolution_lag_h` observation. */
export interface ResolutionLagSample {
  /** Market identifier, used as the `market_id` label. */
  readonly marketId: string;
  /** Hours from expiry to finalization. Negative if finalized before expiry. */
  readonly lagHours: number;
}

/** Everything a scrape needs. Immutable — the server serves it as-is. */
export interface OracleMetricsSnapshot {
  readonly submissionsTotal: number;
  readonly disputesTotal: number;
  readonly resolutionLag: readonly ResolutionLagSample[];
  /** Unix seconds of the last successful refresh, or null if none succeeded. */
  readonly lastRefreshUnixSeconds: number | null;
  /** Refreshes that threw since start. Exposed so a silently stale endpoint is visible. */
  readonly collectionErrors: number;
}

export const EMPTY_SNAPSHOT: OracleMetricsSnapshot = Object.freeze({
  submissionsTotal: 0,
  disputesTotal: 0,
  resolutionLag: Object.freeze([]),
  lastRefreshUnixSeconds: null,
  collectionErrors: 0,
});

const SECONDS_PER_HOUR = 3_600;

interface CountRow extends Record<string, unknown> {
  count: string | number;
}

interface LagRow extends Record<string, unknown> {
  market_id: string;
  end_time: string | number;
  finalized_at_epoch: string | number;
}

/** Total rows in `oracle_submissions`. */
export async function countSubmissions(pool: QueryablePool): Promise<number> {
  const result = await pool.query<CountRow>(`SELECT COUNT(*) AS count FROM oracle_submissions`);
  return toNumber(result.rows[0]?.count);
}

/**
 * Total rows in `oracle_disputes` — every challenged submission, whether or
 * not it went on to escalate to the council. `uq_oracle_disputes_market_id`
 * makes this one row per disputed market.
 */
export async function countDisputes(pool: QueryablePool): Promise<number> {
  const result = await pool.query<CountRow>(`SELECT COUNT(*) AS count FROM oracle_disputes`);
  return toNumber(result.rows[0]?.count);
}

/**
 * Resolution lag for the most recently finalized markets, newest first.
 *
 * @param limit Maximum number of series to return. See
 *              `ORACLE_METRICS_LAG_SERIES` for why this is bounded.
 */
export async function collectResolutionLag(
  pool: QueryablePool,
  limit: number,
): Promise<ResolutionLagSample[]> {
  const result = await pool.query<LagRow>(
    `SELECT s.market_id::text                    AS market_id,
            m.end_time                           AS end_time,
            EXTRACT(EPOCH FROM s.finalized_at)   AS finalized_at_epoch
       FROM oracle_submissions s
       JOIN markets m ON m.id = s.market_id
      WHERE s.status = 'finalized'
        AND s.finalized_at IS NOT NULL
      ORDER BY s.finalized_at DESC
      LIMIT $1`,
    [limit],
  );

  const seen = new Set<string>();
  const samples: ResolutionLagSample[] = [];
  for (const row of result.rows) {
    // A duplicate market_id would emit two samples with identical labels,
    // which is an invalid exposition Prometheus rejects for the whole scrape.
    // The unique index makes this impossible today; the guard keeps a future
    // schema change from breaking the endpoint rather than one query.
    if (seen.has(row.market_id)) continue;
    seen.add(row.market_id);

    samples.push({
      marketId: row.market_id,
      lagHours: (toNumber(row.finalized_at_epoch) - toNumber(row.end_time)) / SECONDS_PER_HOUR,
    });
  }
  return samples;
}

/** Run every query for one snapshot. Throws if any of them fails. */
export async function collectOracleMetrics(
  pool: QueryablePool,
  options: { lagSeries: number; now?: () => number },
): Promise<Omit<OracleMetricsSnapshot, "collectionErrors">> {
  const now = options.now ?? Date.now;
  const [submissionsTotal, disputesTotal, resolutionLag] = await Promise.all([
    countSubmissions(pool),
    countDisputes(pool),
    collectResolutionLag(pool, options.lagSeries),
  ]);

  return {
    submissionsTotal,
    disputesTotal,
    resolutionLag,
    lastRefreshUnixSeconds: Math.floor(now() / 1_000),
  };
}

export interface MetricsCollectorOptions {
  pool: QueryablePool;
  lagSeries: number;
  /** Called with the error and the running failure count. */
  onError?: (error: unknown, consecutiveFailures: number) => void;
  now?: () => number;
}

/**
 * Holds the latest snapshot and refreshes it on demand.
 *
 * A failed refresh keeps the previous snapshot rather than blanking it: a
 * transient Postgres blip must not make `oracle_submissions_total` drop to
 * zero, which would look to Prometheus like a counter reset and produce a
 * spike in every `rate()` over it. The staleness shows up in
 * `oracle_metrics_last_refresh_timestamp_seconds` and
 * `oracle_metrics_collection_errors_total` instead.
 */
export class OracleMetricsCollector {
  private snapshot: OracleMetricsSnapshot = EMPTY_SNAPSHOT;
  private errors = 0;

  constructor(private readonly options: MetricsCollectorOptions) {}

  /** The most recent snapshot. Never throws; safe to call from a request handler. */
  current(): OracleMetricsSnapshot {
    return this.snapshot;
  }

  /** Number of refreshes that have thrown since start. */
  errorCount(): number {
    return this.errors;
  }

  /**
   * Re-read Postgres.
   *
   * @returns true when the refresh succeeded.
   */
  async refresh(): Promise<boolean> {
    try {
      const collected = await collectOracleMetrics(this.options.pool, {
        lagSeries: this.options.lagSeries,
        now: this.options.now,
      });
      this.snapshot = Object.freeze({ ...collected, collectionErrors: this.errors });
      return true;
    } catch (error) {
      this.errors += 1;
      this.snapshot = Object.freeze({ ...this.snapshot, collectionErrors: this.errors });
      this.options.onError?.(error, this.errors);
      return false;
    }
  }
}

/** `COUNT(*)` comes back as a string from `pg` for bigint results. */
function toNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
