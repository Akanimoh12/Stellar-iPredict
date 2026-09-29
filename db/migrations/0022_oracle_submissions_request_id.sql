-- Migration: 0022_oracle_submissions_request_id
-- Issue #467: a submission accepted over HTTP by the backend and the oracle
-- aggregator attempt that later processes the same market run in different
-- processes, and the only thing they share is this table. Record the
-- correlation id of whatever wrote each row -- the backend's request id for
-- a POST /api/oracle/submit, or the aggregator's per-attempt correlation id
-- for a finalized decision -- so one id leads from either side to the other.
--
-- The CHECK mirrors isValidRequestId in backend/src/lib/log.ts (and its copy
-- in oracle/src/log.ts): the value ends up in log lines, so the database
-- refuses anything that convention would reject. Nullable, because rows
-- written before this migration have no id to backfill.

BEGIN;

ALTER TABLE oracle_submissions ADD COLUMN IF NOT EXISTS request_id TEXT;

ALTER TABLE oracle_submissions
  DROP CONSTRAINT IF EXISTS chk_oracle_submissions_request_id;
ALTER TABLE oracle_submissions
  ADD CONSTRAINT chk_oracle_submissions_request_id
  CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9._:-]{1,128}$');

-- Operators look rows up by the id they found in a log line.
CREATE INDEX IF NOT EXISTS idx_oracle_submissions_request_id
  ON oracle_submissions (request_id)
  WHERE request_id IS NOT NULL;

COMMIT;
