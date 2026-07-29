import { Pool } from "pg";
import type { Queryable } from "./markets.js";
import type { OracleSubmissionRow } from "./types.js";

export type { Queryable };

export type RecordOracleSubmissionInput = {
  marketId: number;
  provider: string;
  outcome: string;
  bondAmount?: string | number;
};

let pool: Pool | undefined;

export function setOracleDbPool(p: Pool): void {
  pool = p;
}

export async function recordOracleSubmission(
  input: RecordOracleSubmissionInput,
  db?: Queryable
): Promise<OracleSubmissionRow> {
  const executor = db ?? pool;
  if (!executor) {
    throw new Error("Database pool is not initialized");
  }

  const bondAmountStr = String(input.bondAmount ?? "0");

  const queryText = `
    INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount, status)
    VALUES ($1, $2, $3, $4, 'submitted')
    RETURNING id, market_id, submitter, outcome, bond_amount, submitted_at, status
  `;

  const result = await executor.query<OracleSubmissionRow>(queryText, [
    input.marketId,
    input.provider,
    input.outcome,
    bondAmountStr,
  ]);

  return result.rows[0];
}

export async function getOracleSubmissionsCount(
  marketId: number,
  db?: Queryable
): Promise<number> {
  const executor = db ?? pool;
  if (!executor) {
    throw new Error("Database pool is not initialized");
  }

  const queryText = `
    SELECT COUNT(*)::text AS count
    FROM oracle_submissions
    WHERE market_id = $1 AND status = 'submitted'
  `;

  const result = await executor.query<{ count: string }>(queryText, [marketId]);
  return Number(result.rows[0]?.count ?? 0);
}
