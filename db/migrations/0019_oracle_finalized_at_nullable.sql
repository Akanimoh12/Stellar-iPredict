-- Migration: 0019_oracle_finalized_at_nullable
-- Issue #409: oracle_submissions.finalized_at defaulted to CURRENT_TIMESTAMP,
-- so every freshly submitted row was stamped "finalized" the instant it was
-- inserted -- long before any finalization actually happened. Any read path
-- that treats a non-null finalized_at as "this submission is finalized" got
-- the wrong answer for every row.
--
-- The only write path that inserts a genuinely finalized row
-- (oracle/src/aggregator/market-finalizer.ts) already sets finalized_at
-- explicitly, and every read path that cares (oracle/src/metrics/collector.ts,
-- oracle/src/aggregator/bond-reconciliation.ts) already gates on
-- `status = 'finalized'` / `finalized_at IS NOT NULL`, which only becomes
-- meaningful once this default is gone. So dropping the default and
-- backfilling existing rows is the whole fix -- no application code change
-- is required.

BEGIN;

ALTER TABLE oracle_submissions ALTER COLUMN finalized_at DROP DEFAULT;

-- Backfill: a row is only genuinely finalized when status = 'finalized'.
-- Status is the only trustworthy signal on existing rows (the timestamp
-- itself is what we're correcting), so it's what the backfill keys off.
UPDATE oracle_submissions
SET finalized_at = NULL
WHERE status <> 'finalized';

COMMIT;
