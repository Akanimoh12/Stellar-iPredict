-- Down migration for 0022_oracle_submissions_request_id

BEGIN;

DROP INDEX IF EXISTS idx_oracle_submissions_request_id;
ALTER TABLE oracle_submissions DROP CONSTRAINT IF EXISTS chk_oracle_submissions_request_id;
ALTER TABLE oracle_submissions DROP COLUMN IF EXISTS request_id;

COMMIT;
