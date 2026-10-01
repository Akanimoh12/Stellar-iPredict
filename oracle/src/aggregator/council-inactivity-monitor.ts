import type { QueryablePool } from "./tally.js";

export interface CouncilInactivityAlert {
  marketId: string;
  escalatedAt: string;
  inactiveDurationHours: number;
  detectedAt: string;
}

export interface CouncilWindowExceededAlert {
  marketId: string;
  escalatedAt: string;
  exceededByHours: number;
  detectedAt: string;
}

export interface CouncilDeadlineApproachingAlert {
  marketId: string;
  escalatedAt: string;
  councilDeadline: string;
  hoursRemaining: number;
  detectedAt: string;
}

export interface CouncilInactivityMonitorOptions {
  inactivityThresholdHours?: number; // Default: 48
  onAlert?: (alert: CouncilInactivityAlert) => void;
}

export interface EscalatedMarketRecord {
  marketId: string;
  escalatedAt: Date;
  councilDeadline: Date;
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

export async function checkCouncilWindowExceeded(
  records: EscalatedMarketRecord[],
  now: Date = new Date(),
  onAlert?: (alert: CouncilWindowExceededAlert) => void,
): Promise<CouncilWindowExceededAlert[]> {
  const alerts: CouncilWindowExceededAlert[] = [];

  for (const record of records) {
    if (record.status === "escalated") {
      if (now.getTime() > record.councilDeadline.getTime()) {
        const exceededMs = now.getTime() - record.councilDeadline.getTime();
        const exceededHours = Math.floor(exceededMs / (60 * 60 * 1_000));
        const alert: CouncilWindowExceededAlert = {
          marketId: record.marketId,
          escalatedAt: record.escalatedAt.toISOString(),
          exceededByHours: exceededHours,
          detectedAt: now.toISOString(),
        };
        alerts.push(alert);
        onAlert?.(alert);
      }
    }
  }

  return alerts;
}

export async function checkCouncilDeadlineApproaching(
  records: EscalatedMarketRecord[],
  now: Date = new Date(),
  warningHours: number = 12,
  onAlert?: (alert: CouncilDeadlineApproachingAlert) => void,
): Promise<CouncilDeadlineApproachingAlert[]> {
  const warningMs = warningHours * 60 * 60 * 1_000;
  const alerts: CouncilDeadlineApproachingAlert[] = [];

  for (const record of records) {
    if (record.status === "escalated" && !record.hasCouncilVotes) {
      const timeUntilDeadline = record.councilDeadline.getTime() - now.getTime();
      if (timeUntilDeadline > 0 && timeUntilDeadline <= warningMs) {
        const hoursRemaining = Math.ceil(timeUntilDeadline / (60 * 60 * 1_000));
        const alert: CouncilDeadlineApproachingAlert = {
          marketId: record.marketId,
          escalatedAt: record.escalatedAt.toISOString(),
          councilDeadline: record.councilDeadline.toISOString(),
          hoursRemaining,
          detectedAt: now.toISOString(),
        };
        alerts.push(alert);
        onAlert?.(alert);
      }
    }
  }

  return alerts;
}

// The join is on the raw ids: council_votes.market_id and
// oracle_disputes.market_id are both INTEGER so Postgres compares them directly.
//
// Both queries below query oracle_disputes.status which is an enum with 'escalated'
// member (migration 0009), so no cast is needed.
interface PostgresEscalatedRow extends Record<string, unknown> {
  market_id: string;
  escalated_at: string;
  council_deadline: string;
  status: string;
  vote_count: string | number;
}

export async function checkCouncilInactivityFromDb(
  pool: QueryablePool,
  now: Date = new Date(),
  options: CouncilInactivityMonitorOptions = {},
): Promise<CouncilInactivityAlert[]> {
  const result = await pool.query<PostgresEscalatedRow>(
    `SELECT d.market_id::text AS market_id,
            d.escalated_at::text AS escalated_at,
            d.council_deadline::text AS council_deadline,
            d.status,
            COUNT(v.member) AS vote_count
       FROM oracle_disputes d
  LEFT JOIN council_votes v ON v.market_id::text = d.market_id::text
      WHERE d.status = 'escalated'
   GROUP BY d.market_id, d.escalated_at, d.council_deadline, d.status`,
  );

  const records: EscalatedMarketRecord[] = result.rows.map((row) => ({
    marketId: row.market_id,
    escalatedAt: new Date(row.escalated_at),
    councilDeadline: new Date(row.council_deadline),
    status: row.status,
    hasCouncilVotes: Number(row.vote_count) > 0,
  }));

  return checkCouncilInactivity(records, now, options);
}

export async function checkCouncilWindowExceededFromDb(
  pool: QueryablePool,
  now: Date = new Date(),
  onAlert?: (alert: CouncilWindowExceededAlert) => void,
): Promise<CouncilWindowExceededAlert[]> {
  const result = await pool.query<PostgresEscalatedRow>(
    `SELECT d.market_id::text AS market_id,
            d.escalated_at::text AS escalated_at,
            d.council_deadline::text AS council_deadline,
            d.status,
            COUNT(v.member) AS vote_count
       FROM oracle_disputes d
  LEFT JOIN council_votes v ON v.market_id::text = d.market_id::text
      WHERE d.status = 'escalated'
   GROUP BY d.market_id, d.escalated_at, d.council_deadline, d.status`,
  );

  const records: EscalatedMarketRecord[] = result.rows.map((row) => ({
    marketId: row.market_id,
    escalatedAt: new Date(row.escalated_at),
    councilDeadline: new Date(row.council_deadline),
    status: row.status,
    hasCouncilVotes: Number(row.vote_count) > 0,
  }));

  return checkCouncilWindowExceeded(records, now, onAlert);
}

export async function checkCouncilDeadlineApproachingFromDb(
  pool: QueryablePool,
  now: Date = new Date(),
  warningHours: number = 12,
  onAlert?: (alert: CouncilDeadlineApproachingAlert) => void,
): Promise<CouncilDeadlineApproachingAlert[]> {
  const result = await pool.query<PostgresEscalatedRow>(
    `SELECT d.market_id::text AS market_id,
            d.escalated_at::text AS escalated_at,
            d.council_deadline::text AS council_deadline,
            d.status,
            COUNT(v.member) AS vote_count
       FROM oracle_disputes d
  LEFT JOIN council_votes v ON v.market_id::text = d.market_id::text
      WHERE d.status = 'escalated'
   GROUP BY d.market_id, d.escalated_at, d.council_deadline, d.status`,
  );

  const records: EscalatedMarketRecord[] = result.rows.map((row) => ({
    marketId: row.market_id,
    escalatedAt: new Date(row.escalated_at),
    councilDeadline: new Date(row.council_deadline),
    status: row.status,
    hasCouncilVotes: Number(row.vote_count) > 0,
  }));

  return checkCouncilDeadlineApproaching(records, now, warningHours, onAlert);
}
