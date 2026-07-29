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

export interface OracleSubmissionRecord {
  marketId: string;
  submitter: string;
  bond: bigint;
  status: string;
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
    `SELECT market_id::text AS market_id, submitter, bond_amount, status
       FROM oracle_submissions
      WHERE status IN ('submitted', 'pending')`,
  );

  const records: OracleSubmissionRecord[] = result.rows.map((row) => ({
    marketId: row.market_id,
    submitter: row.submitter,
    bond: BigInt(row.bond_amount),
    status: row.status,
  }));

  return checkBondMinimum(records, options);
}
