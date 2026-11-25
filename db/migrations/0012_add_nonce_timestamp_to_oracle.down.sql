-- Rollback: 0012_add_nonce_timestamp_to_oracle

DROP INDEX IF EXISTS idx_oracle_submissions_request_timestamp;
DROP INDEX IF EXISTS idx_oracle_submissions_nonce;

ALTER TABLE oracle_submissions
    DROP COLUMN IF EXISTS request_timestamp,
    DROP COLUMN IF EXISTS nonce;
