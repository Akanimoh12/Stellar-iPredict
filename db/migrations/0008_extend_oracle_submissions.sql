-- Migration: 0008_extend_oracle_submissions
-- Description: Add finalization tracking and idempotency for oracle submissions.

CREATE TYPE IF NOT EXISTS oracle_submission_status AS ENUM (
    'submitted',
    'challenged',
    'finalized',
    'rejected'
);

ALTER TABLE oracle_submissions
    ADD COLUMN IF NOT EXISTS decision VARCHAR(255),
    ADD COLUMN IF NOT EXISTS tx_hash CHAR(64),
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS council_votes JSONB DEFAULT '{}'::jsonb;

ALTER TABLE oracle_submissions
    ADD CONSTRAINT IF NOT EXISTS uq_oracle_submissions_market_id UNIQUE (market_id);

DROP INDEX IF EXISTS idx_oracle_submissions_market_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_submissions_market_id ON oracle_submissions(market_id);
