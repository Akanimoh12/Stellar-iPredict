import type { Bet, Market } from "@ipredict/shared";

/**
 * Shared TypeScript interfaces for database row shapes.
 * These types mirror the PostgreSQL schema and are used by both
 * the backend API and the indexer to ensure type consistency.
 *
 * Numeric fields are typed as strings to match PostgreSQL's NUMERIC type
 * behavior with the pg driver, which returns numeric values as strings.
 */

// ── Market Row ──────────────────────────────────────────────────────────────

/**
 * Represents a row from the markets table.
 * Mirrors the schema defined in docs/ORACLE_AND_BACKEND.md
 */
export type MarketRow = Market;

// ── Bet Row ────────────────────────────────────────────────────────────────

/**
 * Represents a row from the bets table.
 * Mirrors the schema defined in docs/ORACLE_AND_BACKEND.md
 */
export type BetRow = Bet;

// ── Leaderboard Row ─────────────────────────────────────────────────────────

/**
 * Represents a row from the leaderboard table.
 * Mirrors the schema defined in docs/ORACLE_AND_BACKEND.md
 */
export interface LeaderboardRow {
  address: string; // Stellar address (CHAR(56))
  display_name: string | null;
  points: string; // BIGINT as string
  won_bets: number;
  lost_bets: number;
  updated_at: Date;
}

// ── Event Row ───────────────────────────────────────────────────────────────

/**
 * Represents a row from the events table.
 * Mirrors the schema defined in docs/ORACLE_AND_BACKEND.md
 */
export interface EventRow {
  id: number; // BIGSERIAL
  ledger_seq: number; // BIGINT
  tx_hash: string; // CHAR(64)
  event_type: string; // VARCHAR(50)
  market_id: number | null; // BIGINT, nullable
  actor: string | null; // CHAR(56), nullable
  payload: unknown; // JSONB
  created_at: Date;
}

// ── Oracle Submission Row ───────────────────────────────────────────────────

export type OracleSubmissionStatus =
  | "submitted"
  | "challenged"
  | "finalized"
  | "rejected";

/**
 * Represents a row from the oracle_submissions table.
 * Mirrors the schema defined in db/migrations/0006_oracle_submissions.sql
 */
export interface OracleSubmissionRow {
  id: number;
  market_id: number;
  submitter: string;
  outcome: string;
  bond_amount: string; // NUMERIC as string
  submitted_at: Date;
  status: OracleSubmissionStatus;
}
