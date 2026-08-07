import type { QueryablePool } from "./tally.js";
import type { AggregatorMetrics } from "./metrics.js";

export interface SubmissionRecord {
  id: number;
  marketId: string;
  submitter: string;
  outcome: string;
  bondAmount: bigint;
  submittedAt: Date;
}

export interface NewSubmissionAlert {
  id: number;
  marketId: string;
  submitter: string;
  outcome: string;
  bondAmount: bigint;
  submittedAt: string;
  detectedAt: string;
}

export interface SubmissionWatcherOptions {
  onAlert?: (alert: NewSubmissionAlert) => void;
  metrics?: AggregatorMetrics;
}

export interface DetectNewSubmissionsResult {
  alerts: NewSubmissionAlert[];
  watermark: number;
}

/**
 * Surfaces submissions newer than `sinceId` — the id (from
 * `oracle_submissions`, SERIAL) of the last submission already surfaced.
 *
 * Pure and idempotent given the same inputs: replaying the same
 * `submissions`/`sinceId` pair always yields the same (empty) result, so a
 * submission is never surfaced twice by the watcher — the watermark is the
 * "no double-submit" guard for this monitor.
 */
export function detectNewSubmissions(
  submissions: readonly SubmissionRecord[],
  sinceId: number,
  options: SubmissionWatcherOptions = {},
): DetectNewSubmissionsResult {
  const detectedAt = new Date().toISOString();
  let watermark = sinceId;
  const alerts: NewSubmissionAlert[] = [];

  for (const sub of submissions) {
    if (sub.id <= sinceId) continue;

    const alert: NewSubmissionAlert = {
      id: sub.id,
      marketId: sub.marketId,
      submitter: sub.submitter,
      outcome: sub.outcome,
      bondAmount: sub.bondAmount,
      submittedAt: sub.submittedAt.toISOString(),
      detectedAt,
    };
    alerts.push(alert);
    options.onAlert?.(alert);
    options.metrics?.recordSubmission();
    if (sub.id > watermark) watermark = sub.id;
  }

  return { alerts, watermark };
}

interface PostgresSubmissionRow extends Record<string, unknown> {
  id: number | string;
  market_id: string;
  submitter: string;
  outcome: string;
  bond_amount: string | number;
  submitted_at: string;
}

/**
 * Stateful DB-backed watcher: polls `oracle_submissions` for rows newer than
 * its watermark and surfaces them via `onAlert`. The watermark only ever
 * advances, and the SQL itself filters on `id > $1`, so a restart-free
 * process can call `poll()` on any interval without ever re-surfacing (or
 * losing) a submission.
 */
export class SubmissionWatcher {
  private sinceId: number;

  constructor(
    private readonly pool: QueryablePool,
    private readonly options: SubmissionWatcherOptions = {},
    startingWatermark = 0,
  ) {
    this.sinceId = startingWatermark;
  }

  get watermark(): number {
    return this.sinceId;
  }

  async poll(): Promise<NewSubmissionAlert[]> {
    const result = await this.pool.query<PostgresSubmissionRow>(
      `SELECT id, market_id::text AS market_id, submitter, outcome, bond_amount, submitted_at::text AS submitted_at
         FROM oracle_submissions
        WHERE id > $1
        ORDER BY id ASC`,
      [this.sinceId],
    );

    const records: SubmissionRecord[] = result.rows.map((row) => ({
      id: Number(row.id),
      marketId: row.market_id,
      submitter: row.submitter,
      outcome: row.outcome,
      bondAmount: BigInt(row.bond_amount),
      submittedAt: new Date(row.submitted_at),
    }));

    const { alerts, watermark } = detectNewSubmissions(records, this.sinceId, this.options);
    this.sinceId = watermark;
    return alerts;
  }
}
