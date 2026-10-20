-- Migration: 0028_markets_sort_indexes
-- Description: Covering indexes for the four sort options on GET /api/markets.
--
-- BACKGROUND
-- ----------
-- marketsQuerySchema (backend/src/api/markets.ts) accepts four sort options
-- whose ORDER BY clauses are built in getMarkets (backend/src/db/markets.ts):
--
--   newest      → ORDER BY created_at DESC
--   volume      → ORDER BY (total_yes + total_no) DESC, created_at DESC
--   ending_soon → ORDER BY end_time ASC
--                 (always adds: resolved=FALSE AND cancelled=FALSE AND end_time > now())
--   bettors     → ORDER BY bet_count DESC, created_at DESC
--
-- Migration 0002 predates these sort options; migrations 0013/0014 added
-- idx_markets_volume and idx_markets_active_partial but neither covers
-- bettors nor newest.
--
-- MEASUREMENT RATIONALE
-- ---------------------
-- The default request is (sort=newest, filter=all, no category), which
-- dominates traffic per cache-key distribution.  bettors is the next most
-- common non-default sort (discovery pages).  ending_soon is already served
-- by idx_markets_active_partial (end_time WHERE resolved=FALSE AND
-- cancelled=FALSE).  volume gains a tiebreaker to make the sort stable.
--
-- We add exactly three indexes, one per gap, rather than one per
-- sort × filter × category combination (which would be 4 × 5 × 6 = 120).
-- Each insert/update to markets pays the maintenance cost of every index on
-- the table, so fewer, broader indexes win on write-heavy tables.
--
-- INDEX DECISIONS
-- ---------------
--
-- 1. idx_markets_created_at
--    Covers sort=newest for every filter (active/resolved/ended/cancelled/all)
--    and every category.  A plain descending index lets Postgres perform an
--    index scan in creation-date order without a sort step.  It also covers
--    the created_at tiebreaker in the volume and bettors order clauses when
--    the planner chooses an index scan over those columns.
--
--    Why not a partial index (e.g. WHERE resolved=FALSE)?  newest is the
--    default for every filter including "all" and "resolved", so a full-table
--    index is the only option that covers all combinations without forcing a
--    fallback sort for non-active rows.
--
-- 2. idx_markets_volume_tiebreak  (replaces idx_markets_volume from 0013)
--    idx_markets_volume covers (total_yes + total_no) DESC but omits the
--    created_at DESC tiebreaker, leaving Postgres to sort ties in-memory.
--    Adding created_at makes the ORDER BY deterministic and plan-stable.
--    The old index is dropped first so the new one carries the same effective
--    purpose without duplicating storage.
--
--    Note: expression indexes on (total_yes + total_no) require the query's
--    expression to match exactly (same operator, same column order) for the
--    planner to use them.  getMarkets uses `(total_yes + total_no) DESC`,
--    which matches.
--
-- 3. idx_markets_bettors
--    Covers sort=bettors (bet_count DESC, created_at DESC).  Because bettors
--    sort is only meaningful on open/active markets in practice, this is a
--    partial index (WHERE resolved=FALSE AND cancelled=FALSE).  For the
--    filter=all path the planner can still fall back to a full sort, which is
--    acceptable — the partial index exists for the hot active-market path.
--    Adding a full index here would double the maintenance cost for a cold
--    code path.
--
-- WRITE PERFORMANCE NOTE
-- ----------------------
-- Every additional index costs one extra B-tree page write per INSERT and one
-- conditional write per UPDATE (only when indexed columns change).  Markets
-- are written infrequently (one insert per on-chain create_market; updates
-- only on bet/resolve/cancel events).  Three small indexes add negligible
-- overhead compared to the existing six indexes already on this table.
--
-- LOCK NOTE
-- ---------
-- Like migration 0014, these are standard (non-CONCURRENT) CREATE INDEX
-- statements because the migration runner wraps each file in a transaction and
-- CONCURRENTLY cannot run inside a transaction.  Each index briefly holds a
-- SHARE lock that blocks writes to markets.  For zero-write-downtime deploys,
-- run these as CREATE INDEX CONCURRENTLY outside the runner, then rerun
-- migrations to record the completion.

BEGIN;

-- 1. newest sort — all filter/category combinations
CREATE INDEX IF NOT EXISTS idx_markets_created_at
  ON markets (created_at DESC);

-- 2. volume sort — drop the old no-tiebreaker index, add a stable replacement
DROP INDEX IF EXISTS idx_markets_volume;

CREATE INDEX IF NOT EXISTS idx_markets_volume_tiebreak
  ON markets ((total_yes + total_no) DESC, created_at DESC);

-- 3. bettors sort — partial index covering the hot active-markets path
CREATE INDEX IF NOT EXISTS idx_markets_bettors
  ON markets (bet_count DESC, created_at DESC)
  WHERE resolved = FALSE AND cancelled = FALSE;

COMMIT;
