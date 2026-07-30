/**
 * Bond refund reconciliation job  (#163)
 *
 * Reconciles expected vs actual bond refunds for the optimistic oracle.
 *
 * ## What this does
 *
 * After a market is finalized (challenged or unchallenged), the smart contract
 * distributes bonds on-chain.  Off-chain we independently verify that every
 * terminal `oracle_submissions` row has a matching `bond_settled` record.
 * Any row that has reached a terminal status but has NOT been settled is
 * flagged as a `BondRefundDiscrepancy`.
 *
 * The reconciliation job:
 * 1. Loads all terminal submissions (`finalized`, `cancelled`, `expired`).
 * 2. Loads all settlement records (`bond_settlements`).
 * 3. Diffs them — entries in (1) with no matching entry in (2) are flagged.
 * 4. Emits alerts and optionally triggers corrective action via a callback.
 *
 * ## Double-submit / double-payout safety
 *
 * Settlement records are keyed on `(market_id, recipient)` with a UNIQUE
 * constraint.  The corrective `recordSettlement` function uses
 * INSERT … ON CONFLICT DO NOTHING so a concurrent call for the same market
 * is a no-op rather than a duplicate payout.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Bond Mechanics
 */

import type { QueryablePool } from "./tally.js";
import type { Logger } from "../log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single oracle submission row in a terminal state. */
export interface TerminalSubmission {
  marketId: string;
  submitter: string;
  /** Amount in stroops (1 XLM = 10_000_000 stroops). */
  bondAmount: bigint;
  /** Final state: finalized | cancelled | expired */
  status: "finalized" | "cancelled" | "expired";
  finalizedAt: Date;
}

/** A recorded bond settlement — proof a bond was returned on-chain. */
export interface BondSettlement {
  marketId: string;
  recipient: string;
  /** Amount in stroops that was settled/returned. */
  settledAmount: bigint;
  settledAt: Date;
}

/**
 * A discrepancy: a terminal submission whose bond has NOT been settled.
 */
export interface BondRefundDiscrepancy {
  marketId: string;
  submitter: string;
  expectedAmount: bigint;
  status: "finalized" | "cancelled" | "expired";
  finalizedAt: Date;
  detectedAt: string;
}

export interface BondReconciliationOptions {
  /**
   * Called for every detected discrepancy.  Use to emit metrics, page
   * on-call, or trigger a corrective settlement transaction.
   */
  onDiscrepancy?: (d: BondRefundDiscrepancy) => Promise<void> | void;
  logger?: Logger;
}

export interface BondReconciliationResult {
  checkedCount: number;
  settledCount: number;
  discrepancies: BondRefundDiscrepancy[];
  ranAt: string;
}

// ---------------------------------------------------------------------------
// DB row shapes (internal)
// ---------------------------------------------------------------------------

interface SubmissionRow extends Record<string, unknown> {
  market_id: string;
  submitter: string;
  bond_amount: string | number;
  status: string;
  finalized_at: string | Date;
}

interface SettlementRow extends Record<string, unknown> {
  market_id: string;
  recipient: string;
  settled_amount: string | number;
  settled_at: string | Date;
}

// ---------------------------------------------------------------------------
// Core reconciliation logic
// ---------------------------------------------------------------------------

/**
 * Pure reconciler — compares `submissions` to `settlements` and returns
 * discrepancies.  Exported separately so it can be unit-tested without a DB.
 */
export function reconcileBonds(
  submissions: TerminalSubmission[],
  settlements: BondSettlement[],
): BondRefundDiscrepancy[] {
  // Build a lookup keyed by marketId for O(1) membership tests.
  const settledMarkets = new Set<string>(settlements.map((s) => s.marketId));

  const nowIso = new Date().toISOString();
  const discrepancies: BondRefundDiscrepancy[] = [];

  for (const sub of submissions) {
    if (!settledMarkets.has(sub.marketId)) {
      discrepancies.push({
        marketId: sub.marketId,
        submitter: sub.submitter,
        expectedAmount: sub.bondAmount,
        status: sub.status,
        finalizedAt: sub.finalizedAt,
        detectedAt: nowIso,
      });
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// DB-backed reconciliation
// ---------------------------------------------------------------------------

/**
 * Run a full bond refund reconciliation pass against the database.
 *
 * Reads `oracle_submissions` (terminal rows) and `bond_settlements`, then
 * calls `options.onDiscrepancy` for every market whose bond has not been
 * settled.
 *
 * @returns Summary of the reconciliation run.
 */
export async function runBondReconciliation(
  pool: QueryablePool,
  options: BondReconciliationOptions = {},
): Promise<BondReconciliationResult> {
  const { onDiscrepancy, logger } = options;
  const ranAt = new Date().toISOString();

  // 1. Load terminal submissions.
  const submissionResult = await pool.query<SubmissionRow>(
    `SELECT market_id::text AS market_id,
            submitter,
            bond_amount,
            status,
            finalized_at
       FROM oracle_submissions
      WHERE status IN ('finalized', 'cancelled', 'expired')
      ORDER BY finalized_at ASC`,
  );

  const submissions: TerminalSubmission[] = submissionResult.rows.map((row) => ({
    marketId: row.market_id,
    submitter: row.submitter,
    bondAmount: BigInt(row.bond_amount),
    status: row.status as TerminalSubmission["status"],
    finalizedAt: new Date(row.finalized_at as string),
  }));

  // 2. Load settlement records.
  const settlementResult = await pool.query<SettlementRow>(
    `SELECT market_id::text AS market_id,
            recipient,
            settled_amount,
            settled_at
       FROM bond_settlements
      ORDER BY settled_at ASC`,
  );

  const settlements: BondSettlement[] = settlementResult.rows.map((row) => ({
    marketId: row.market_id,
    recipient: row.recipient,
    settledAmount: BigInt(row.settled_amount),
    settledAt: new Date(row.settled_at as string),
  }));

  // 3. Diff.
  const discrepancies = reconcileBonds(submissions, settlements);

  logger?.info("bond reconciliation complete", {
    checkedCount: submissions.length,
    settledCount: settlements.length,
    discrepancyCount: discrepancies.length,
    ranAt,
  });

  // 4. Emit alerts / corrective callbacks.
  for (const d of discrepancies) {
    logger?.warn("bond refund discrepancy detected", {
      marketId: d.marketId,
      submitter: d.submitter,
      expectedAmountStroops: String(d.expectedAmount),
      status: d.status,
      finalizedAt: d.finalizedAt.toISOString(),
    });
    if (onDiscrepancy) {
      await onDiscrepancy(d);
    }
  }

  return {
    checkedCount: submissions.length,
    settledCount: settlements.length,
    discrepancies,
    ranAt,
  };
}

// ---------------------------------------------------------------------------
// Settlement recorder (corrective action helper)
// ---------------------------------------------------------------------------

export interface RecordSettlementInput {
  marketId: string;
  recipient: string;
  settledAmountStroops: bigint;
}

/**
 * Persist a bond settlement record.
 *
 * Uses INSERT … ON CONFLICT DO NOTHING so calling this twice for the same
 * `(market_id, recipient)` is idempotent — the second call is silently
 * ignored, preventing double-payouts.
 *
 * @returns `true` if a new row was inserted, `false` if it already existed.
 */
export async function recordSettlement(
  pool: QueryablePool,
  input: RecordSettlementInput,
): Promise<boolean> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO bond_settlements (market_id, recipient, settled_amount, settled_at)
          VALUES ($1, $2, $3, NOW())
     ON CONFLICT (market_id, recipient) DO NOTHING
     RETURNING market_id`,
    [input.marketId, input.recipient, String(input.settledAmountStroops)],
  );
  return (result.rows.length ?? 0) > 0;
}
