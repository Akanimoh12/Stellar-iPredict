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

-- ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL. We guard with a DO block.
-- A UNIQUE constraint implicitly creates its own index, so we don't need a
-- separate CREATE UNIQUE INDEX statement. The duplicate index has been removed.
DO $$
BEGIN
    ALTER TABLE oracle_submissions
        ADD CONSTRAINT uq_oracle_submissions_market_id UNIQUE (market_id);
EXCEPTION
    WHEN duplicate_object OR duplicate_table THEN NULL;
END
$$;
