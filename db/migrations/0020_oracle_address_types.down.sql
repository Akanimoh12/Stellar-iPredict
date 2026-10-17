-- Down migration for 0020_oracle_address_types

BEGIN;

COMMENT ON COLUMN oracle_disputes.outcome IS NULL;
COMMENT ON COLUMN oracle_submissions.outcome IS NULL;

ALTER TABLE oracle_disputes DROP CONSTRAINT IF EXISTS ck_oracle_disputes_outcome_canonical;
ALTER TABLE oracle_disputes DROP CONSTRAINT IF EXISTS ck_oracle_disputes_challenger_address;
ALTER TABLE oracle_disputes DROP CONSTRAINT IF EXISTS ck_oracle_disputes_submitter_address;
ALTER TABLE oracle_submissions DROP CONSTRAINT IF EXISTS ck_oracle_submissions_submitter_address;

ALTER TABLE oracle_disputes ALTER COLUMN challenger TYPE VARCHAR(255);
ALTER TABLE oracle_disputes ALTER COLUMN submitter TYPE VARCHAR(255);
ALTER TABLE oracle_submissions ALTER COLUMN submitter TYPE VARCHAR(255);

COMMIT;
