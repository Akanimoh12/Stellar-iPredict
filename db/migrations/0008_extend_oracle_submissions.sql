-- Migration: 0008_extend_oracle_submissions
-- Description: Add finalization tracking and idempotency for oracle submissions.

-- PostgreSQL has no CREATE TYPE ... IF NOT EXISTS, so the re-run guard has to
-- be the exception handler.
DO $$
BEGIN
    CREATE TYPE oracle_submission_status AS ENUM (
        'submitted',
        'challenged',
        'finalized',
        'rejected'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE oracle_submissions
    ADD COLUMN IF NOT EXISTS decision VARCHAR(255),
    ADD COLUMN IF NOT EXISTS tx_hash CHAR(64),
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS council_votes JSONB DEFAULT '{}'::jsonb;

-- Likewise, ADD CONSTRAINT has no IF NOT EXISTS. duplicate_table covers the
-- index the UNIQUE constraint creates behind it.
DO $$
BEGIN
    ALTER TABLE oracle_submissions
        ADD CONSTRAINT uq_oracle_submissions_market_id UNIQUE (market_id);
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END
$$;

DROP INDEX IF EXISTS idx_oracle_submissions_market_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_submissions_market_id ON oracle_submissions(market_id);
