import { Pool } from "pg";
import type { Queryable } from "./markets.js";
import type { OracleSubmissionRow } from "./types.js";

export type { Queryable };

export type RecordOracleSubmissionInput = {
  marketId: number;
  provider: string;
  outcome: string;
  bondAmount?: string | number;
  nonce?: string;
  requestTimestamp?: Date;
};

let pool: Pool | undefined;

export function setOracleDbPool(p: Pool): void {
  pool = p;
}

export async function recordOracleSubmission(
  input: RecordOracleSubmissionInput,
  db?: Queryable,
): Promise<OracleSubmissionRow> {
  const executor = db ?? pool;
  if (!executor) {
    throw new Error("Database pool is not initialized");
  }

  const bondAmountStr = String(input.bondAmount ?? "0");

  const queryText = `
    INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount, status, nonce, request_timestamp)
    VALUES ($1, $2, $3, $4, 'submitted', $5, $6)
    RETURNING id, market_id, submitter, outcome, bond_amount, submitted_at, status
  `;

  const result = await executor.query<OracleSubmissionRow>(queryText, [
    input.marketId,
    input.provider,
    input.outcome,
    bondAmountStr,
    input.nonce ?? null,
    input.requestTimestamp ?? null,
  ]);

  return result.rows[0];
}

export async function getOracleSubmissionsCount(
  marketId: number,
  db?: Queryable,
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

/**
 * Check if a nonce has been used before.
 * Returns true if the nonce exists in the database.
 */
export async function hasNonceBeenUsed(
  nonce: string,
  db?: Queryable,
): Promise<boolean> {
  const executor = db ?? pool;
  if (!executor) {
    throw new Error("Database pool is not initialized");
  }

  const queryText = `
    SELECT 1
    FROM oracle_submissions
    WHERE nonce = $1
    LIMIT 1
  `;

  const result = await executor.query(queryText, [nonce]);
  return result.rows.length > 0;
}

/**
 * Clean up expired nonces based on retention period.
 * Removes nonces older than the retention window to prevent unbounded growth.
 */
export async function cleanupExpiredNonces(
  retentionSeconds: number,
  db?: Queryable,
): Promise<number> {
  const executor = db ?? pool;
  if (!executor) {
    throw new Error("Database pool is not initialized");
  }

  const cutoffTime = new Date(Date.now() - retentionSeconds * 1000);

  const queryText = `
    DELETE FROM oracle_submissions
    WHERE nonce IS NOT NULL
      AND request_timestamp < $1
    RETURNING id
  `;

  const result = await executor.query(queryText, [cutoffTime]);
  return result.rowCount ?? 0;
}
