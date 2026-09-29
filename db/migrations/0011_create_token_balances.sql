-- Migration: 0011_create_token_balances
-- Description: Creates token_balances table for tracking IPRED token holdings.
--
-- Design Decision: Track token balances via on-chain events (mint, transfer)
-- rather than querying SAC balances on-demand. This approach:
--   1. Provides historical balance snapshots
--   2. Reduces RPC load (no balance queries per user)
--   3. Enables fast leaderboard/profile queries
--   4. Maintains consistency with other indexed data
--
-- The indexer listens for token_mint and token_transfer events and updates
-- this table incrementally. For full reconciliation, a backfill job can query
-- the SAC contract's balance() method for all known addresses.

CREATE TABLE IF NOT EXISTS token_balances (
  address       CHAR(56) PRIMARY KEY,
  balance       NUMERIC(30,7) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_balances_balance ON token_balances(balance DESC);
CREATE INDEX IF NOT EXISTS idx_token_balances_updated_at ON token_balances(updated_at DESC);
