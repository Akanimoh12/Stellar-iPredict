import type { QueryablePool } from "./tally.js";

export interface DisputeEscalationRecord {
  marketId: string;
  submitter: string;
  challenger: string;
  outcome: string;
  totalBond: bigint;
  escalatedAt: Date;
  councilDeadline: Date;
}

export interface DisputeEscalationAlert {
  marketId: string;
  submitter: string;
  challenger: string;
  outcome: string;
  totalBond: bigint;
  escalatedAt: string;
  councilDeadline: string;
  detectedAt: string;
}

export interface DisputeEscalationWatcherOptions {
  onAlert?: (alert: DisputeEscalationAlert) => void;
}

export interface DetectDisputeEscalationsResult {
  alerts: DisputeEscalationAlert[];
  watermark: Date;
}

/**
 * Surfaces disputes that escalated to council after `since` (a market's
 * `escalated_at` from `oracle_disputes`, set once by the `challenge()`
 * contract call — see #148 / migration 0009).
 *
 * Pure and idempotent given the same inputs: replaying the same
 * `disputes`/`since` pair always yields the same (empty) result, so an
 * escalation is never alerted twice — the watermark is the "no
 * double-submit" guard for this monitor. It doesn't move funds (bonds only
 * settle on `finalized`), so there's no payout path here to double either.
 */
export function detectDisputeEscalations(
  disputes: readonly DisputeEscalationRecord[],
  since: Date,
  options: DisputeEscalationWatcherOptions = {},
): DetectDisputeEscalationsResult {
  const detectedAt = new Date().toISOString();
  let watermark = since;
  const alerts: DisputeEscalationAlert[] = [];

  for (const dispute of disputes) {
    if (dispute.escalatedAt.getTime() <= since.getTime()) continue;

    const alert: DisputeEscalationAlert = {
      marketId: dispute.marketId,
      submitter: dispute.submitter,
      challenger: dispute.challenger,
      outcome: dispute.outcome,
      totalBond: dispute.totalBond,
      escalatedAt: dispute.escalatedAt.toISOString(),
      councilDeadline: dispute.councilDeadline.toISOString(),
      detectedAt,
    };
    alerts.push(alert);
    options.onAlert?.(alert);
    if (dispute.escalatedAt.getTime() > watermark.getTime()) watermark = dispute.escalatedAt;
  }

  return { alerts, watermark };
}

interface PostgresDisputeRow extends Record<string, unknown> {
  market_id: string;
  submitter: string;
  challenger: string;
  outcome: string;
  total_bond: string | number;
  escalated_at: string;
  council_deadline: string;
}

/**
 * Stateful DB-backed watcher: polls `oracle_disputes` for escalations newer
 * than its watermark and surfaces them via `onAlert`. The watermark only
 * ever advances, and the SQL itself filters on `escalated_at > $1`, so
 * `poll()` can be called on any interval without ever re-alerting (or
 * missing) an escalation.
 */
export class DisputeEscalationWatcher {
  private since: Date;

  constructor(
    private readonly pool: QueryablePool,
    private readonly options: DisputeEscalationWatcherOptions = {},
    startingWatermark: Date = new Date(0),
  ) {
    this.since = startingWatermark;
  }

  get watermark(): Date {
    return this.since;
  }

  async poll(): Promise<DisputeEscalationAlert[]> {
    const result = await this.pool.query<PostgresDisputeRow>(
      `SELECT market_id::text AS market_id, submitter, challenger, outcome,
              total_bond, escalated_at::text AS escalated_at, council_deadline::text AS council_deadline
         FROM oracle_disputes
        WHERE status = 'escalated' AND escalated_at > $1
        ORDER BY escalated_at ASC`,
      [this.since.toISOString()],
    );

    const records: DisputeEscalationRecord[] = result.rows.map((row) => ({
      marketId: row.market_id,
      submitter: row.submitter,
      challenger: row.challenger,
      outcome: row.outcome,
      totalBond: BigInt(row.total_bond),
      escalatedAt: new Date(row.escalated_at),
      councilDeadline: new Date(row.council_deadline),
    }));

    const { alerts, watermark } = detectDisputeEscalations(records, this.since, this.options);
    this.since = watermark;
    return alerts;
  }
}
