import type { QueryablePool } from "../aggregator/tally.js";

export interface BondAlert {
  marketId: string;
  submitter: string;
  currentBond: bigint;
  requiredMinimum: bigint;
  detectedAt: string;
}

export interface BondMonitorOptions {
  requiredMinimumBond: bigint; // Default: 100_0000000n (100 XLM)
  onAlert?: (alert: BondAlert) => void;
}

export interface BondSpendLimitOptions {
  hourlySpendLimit: bigint;
  alertThresholdPercent: number;
}

export interface BondSpendStatus {
  hourlySpend: bigint;
  hourlySpendLimit: bigint;
  alertThresholdPercent: number;
  limitApproached: boolean;
  limitExceeded: boolean;
}

export interface OracleSubmissionRecord {
  marketId: string;
  submitter: string;
  bond: bigint;
  status: string;
}

export class BondSpendLimitExceededError extends Error {
  constructor(
    public readonly hourlySpend: bigint,
    public readonly requestedSpend: bigint,
    public readonly hourlySpendLimit: bigint,
  ) {
    super(
      `bond spend limit exceeded: ${hourlySpend} already spent in the last hour, ` +
      `${requestedSpend} requested, limit is ${hourlySpendLimit}`,
    );
    this.name = "BondSpendLimitExceededError";
  }
}

function validateBondSpendOptions(options: BondSpendLimitOptions): void {
  if (options.hourlySpendLimit <= 0n) {
    throw new RangeError("hourlySpendLimit must be greater than zero");
  }
  if (
    !Number.isInteger(options.alertThresholdPercent) ||
    options.alertThresholdPercent < 1 ||
    options.alertThresholdPercent > 100
  ) {
    throw new RangeError("alertThresholdPercent must be an integer from 1 to 100");
  }
}

export async function checkBondSpendFromDb(
  pool: QueryablePool,
  options: BondSpendLimitOptions,
  now: Date = new Date(),
): Promise<BondSpendStatus> {
  validateBondSpendOptions(options);
  const result = await pool.query<{ hourly_spend: string | number }>(
    `SELECT COALESCE(SUM(challenger_bond), 0)::text AS hourly_spend
       FROM oracle_disputes
      WHERE COALESCE(challenged_at, created_at) >= $1
        AND COALESCE(challenged_at, created_at) <= $2`,
    [new Date(now.getTime() - 60 * 60 * 1_000), now],
  );
  const rawHourlySpend = result.rows[0]?.hourly_spend;
  if (rawHourlySpend === undefined || rawHourlySpend === null) {
    throw new Error("hourly bond spend query returned no aggregate value");
  }
  const hourlySpend = BigInt(rawHourlySpend);
  const alertAt = (
    options.hourlySpendLimit * BigInt(options.alertThresholdPercent) + 99n
  ) / 100n;
  const limitExceeded = hourlySpend >= options.hourlySpendLimit;

  return {
    hourlySpend,
    hourlySpendLimit: options.hourlySpendLimit,
    alertThresholdPercent: options.alertThresholdPercent,
    limitApproached: hourlySpend >= alertAt,
    limitExceeded,
  };
}

/**
 * Guard an outgoing challenge bond against the rolling one-hour spend limit.
 * Pass this function as `ChallengeBotOptions.bondSpendGuard` to enforce the
 * same limit immediately before a challenge transaction is submitted.
 */
export async function assertBondSpendWithinHourlyLimit(
  pool: QueryablePool,
  requestedSpend: bigint,
  options: BondSpendLimitOptions,
  now: Date = new Date(),
): Promise<void> {
  validateBondSpendOptions(options);
  if (requestedSpend < 0n) throw new RangeError("requestedSpend cannot be negative");

  const status = await checkBondSpendFromDb(pool, options, now);
  if (status.hourlySpend + requestedSpend > status.hourlySpendLimit) {
    throw new BondSpendLimitExceededError(
      status.hourlySpend,
      requestedSpend,
      status.hourlySpendLimit,
    );
  }
}

export async function checkBondMinimum(
  submissions: OracleSubmissionRecord[],
  options: BondMonitorOptions,
): Promise<BondAlert[]> {
  const alerts: BondAlert[] = [];
  const nowIso = new Date().toISOString();

  for (const sub of submissions) {
    if (sub.status === "submitted" || sub.status === "pending") {
      if (sub.bond < options.requiredMinimumBond) {
        const alert: BondAlert = {
          marketId: sub.marketId,
          submitter: sub.submitter,
          currentBond: sub.bond,
          requiredMinimum: options.requiredMinimumBond,
          detectedAt: nowIso,
        };
        alerts.push(alert);
        options.onAlert?.(alert);
      }
    }
  }

  return alerts;
}

interface PostgresSubmissionRow extends Record<string, unknown> {
  market_id: string;
  submitter: string;
  bond_amount: string | number;
  status: string;
}

export async function checkBondMinimumFromDb(
  pool: QueryablePool,
  options: BondMonitorOptions,
): Promise<BondAlert[]> {
  const result = await pool.query<PostgresSubmissionRow>(
    // status::text, not status: `oracle_submission_status` (migration 0008)
    // has no 'pending' member, and comparing the enum against a literal it
    // does not contain is a hard Postgres error, not an empty result. The
    // cast keeps the pure checkBondMinimum contract — which does treat
    // 'pending' as open — valid against today's schema and any later one.
    `SELECT market_id::text AS market_id, submitter, bond_amount, status
       FROM oracle_submissions
      WHERE status::text IN ('submitted', 'pending')`,
  );

  const records: OracleSubmissionRecord[] = result.rows.map((row) => ({
    marketId: row.market_id,
    submitter: row.submitter,
    bond: BigInt(row.bond_amount),
    status: row.status,
  }));

  return checkBondMinimum(records, options);
}
