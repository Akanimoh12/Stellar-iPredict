import type { QueryablePool } from "./tally.js";

export interface CouncilInactivityAlert {
  marketId: string;
  escalatedAt: string;
  inactiveDurationHours: number;
  detectedAt: string;
}

export interface CouncilInactivityMonitorOptions {
  inactivityThresholdHours?: number; // Default: 48
  onAlert?: (alert: CouncilInactivityAlert) => void;
}

export interface EscalatedMarketRecord {
  marketId: string;
  escalatedAt: Date;
  status: string;
  hasCouncilVotes: boolean;
}

export async function checkCouncilInactivity(
  records: EscalatedMarketRecord[],
  now: Date = new Date(),
  options: CouncilInactivityMonitorOptions = {},
): Promise<CouncilInactivityAlert[]> {
  const thresholdHours = options.inactivityThresholdHours ?? 48;
  const thresholdMs = thresholdHours * 60 * 60 * 1_000;
  const alerts: CouncilInactivityAlert[] = [];

  for (const record of records) {
    if (record.status === "escalated" || !record.hasCouncilVotes) {
      const elapsedMs = now.getTime() - record.escalatedAt.getTime();
      if (elapsedMs >= thresholdMs) {
        const hours = Math.floor(elapsedMs / (60 * 60 * 1_000));
        const alert: CouncilInactivityAlert = {
          marketId: record.marketId,
          escalatedAt: record.escalatedAt.toISOString(),
          inactiveDurationHours: hours,
          detectedAt: now.toISOString(),
        };
        alerts.push(alert);
        options.onAlert?.(alert);
      }
    }
  }

  return alerts;
}

interface PostgresEscalatedRow extends Record<string, unknown> {
  market_id: string;
  escalated_at: string;
  status: string;
  vote_count: string | number;
}

export async function checkCouncilInactivityFromDb(
  pool: QueryablePool,
  now: Date = new Date(),
  options: CouncilInactivityMonitorOptions = {},
): Promise<CouncilInactivityAlert[]> {
  const result = await pool.query<PostgresEscalatedRow>(
    `SELECT s.market_id::text AS market_id,
            s.submitted_at::text AS escalated_at,
            s.status,
            COUNT(v.member) AS vote_count
       FROM oracle_submissions s
  LEFT JOIN council_votes v ON v.market_id = s.market_id::text
      WHERE s.status = 'escalated'
   GROUP BY s.market_id, s.submitted_at, s.status`,
  );

  const records: EscalatedMarketRecord[] = result.rows.map((row) => ({
    marketId: row.market_id,
    escalatedAt: new Date(row.escalated_at),
    status: row.status,
    hasCouncilVotes: Number(row.vote_count) > 0,
  }));

  return checkCouncilInactivity(records, now, options);
}
