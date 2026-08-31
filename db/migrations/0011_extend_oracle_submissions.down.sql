-- Down migration: 0011_extend_oracle_submissions.down
-- Reverts 0011_extend_oracle_submissions.sql
--
-- NOTE: The up-migration idempotently creates oracle_submission_status ENUM, but the
--       type itself originates from 0006_oracle_submissions. This down-migration does
--       NOT drop the ENUM because it would also affect rows created by 0006, and the
--       type's scope extends beyond this extension. The ENUM is dropped only when
--       0006 is reverted.

DROP INDEX IF EXISTS idx_oracle_submissions_market_id;

ALTER TABLE oracle_submissions
    DROP CONSTRAINT IF EXISTS uq_oracle_submissions_market_id;

ALTER TABLE oracle_submissions
    DROP COLUMN IF EXISTS council_votes,
    DROP COLUMN IF EXISTS finalized_at,
    DROP COLUMN IF EXISTS tx_hash,
    DROP COLUMN IF EXISTS decision;

CREATE INDEX IF NOT EXISTS idx_oracle_submissions_market_id ON oracle_submissions(market_id);