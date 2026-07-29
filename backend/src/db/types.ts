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
export interface MarketRow {
  id: number;
  question: string;
  image_url: string | null;
  category: string;
  end_time: string; // Unix timestamp as string (BIGINT from DB)
  total_yes: string; // NUMERIC(30,7) as string
  total_no: string; // NUMERIC(30,7) as string
  resolved: boolean;
  outcome: boolean | null;
  cancelled: boolean;
  creator: string; // Stellar address (CHAR(56))
  bet_count: number;
  created_at: Date;
  updated_at: Date;
}

// ── Bet Row ────────────────────────────────────────────────────────────────

/**
 * Represents a row from the bets table.
 * Mirrors the schema defined in docs/ORACLE_AND_BACKEND.md
 */
export interface BetRow {
  market_id: string; // BIGINT as string
  bettor: string; // Stellar address (CHAR(56))
  net_amount: string; // NUMERIC(30,7) as string
  gross_amount: string; // NUMERIC(30,7) as string
  is_yes: boolean;
  claimed: boolean;
  created_at: Date;
}

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
