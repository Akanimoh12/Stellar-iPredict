-- Migration: 0014_markets_active_partial_index
-- Description: Add a partial composite index for the aggregator
-- expired-markets query (see issue #410).

-- The aggregator (oracle/src/aggregator/index.ts) polls this on every interval:
--
--   SELECT id::text, cancelled FROM markets
--   WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE
--   ORDER BY end_time ASC;
--
-- With the default 5-second poll this is one of the hottest queries in the
-- system. The existing `idx_markets_active (resolved, cancelled, end_time)`
-- (migration 0002) is an uncompressed full-table index: it covers the
-- predicate columns, but the overwhelmingly majority of rows eventually
-- resolve, so a planner scanning it must walk every market that ever existed.
--
-- This partial index (`WHERE resolved = FALSE AND cancelled = FALSE`) only
-- contains the small, ever-shrinking set of live markets. Leading with
-- `end_time` lets the planner serve the `end_time <= $1 ... ORDER BY end_time`
-- scan directly, and the index is far smaller than its full counterpart.
--
-- Lock note: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and
-- this migration runs inside the runner's transaction (migrate.ts wraps each
-- file in a transaction). As a result the non-concurrent form below briefly
-- takes a SHARE lock that blocks writes to `markets`. The aggregator only
-- reads, so a short write stall on `markets` during deploy is the accepted
-- trade for a tiny index here. If zero-write-downtime matters, run it as
-- `CREATE INDEX CONCURRENTLY` outside the runner.

CREATE INDEX IF NOT EXISTS idx_markets_active_partial
ON markets (end_time)
WHERE resolved = FALSE AND cancelled = FALSE;
