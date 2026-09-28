-- Migration: 0026_dead_letter_events_timestamptz
-- Issue #495: move dead_letter_events from runtime DDL in the indexer to a
-- proper migration, and fix created_at to TIMESTAMPTZ for consistency with
-- the rest of the schema.
--
-- Two cases to handle:
--   1. Fresh environment: the table does not yet exist → CREATE TABLE creates
--      it correctly with TIMESTAMPTZ from the start.
--   2. Deployed environment: the table was already created at runtime by
--      deadLetterTableSql (TIMESTAMP, no timezone) → the CREATE TABLE is
--      skipped (IF NOT EXISTS), the ALTER TABLE USING cast converts the
--      column, and the CREATE INDEX statements are skipped (IF NOT EXISTS) if
--      the indexer already created them.

BEGIN;

-- ── Create table (fresh environments) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_letter_events (
  id            BIGSERIAL PRIMARY KEY,
  ledger_seq    BIGINT    NOT NULL,
  tx_hash       CHAR(64)  NOT NULL,
  raw_event     JSONB     NOT NULL,
  error_message TEXT      NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Upgrade column type (deployed environments with TIMESTAMP) ─────────────
-- AT TIME ZONE 'UTC' interprets the stored bare timestamp as UTC and produces
-- a TIMESTAMPTZ. This is a no-op if the column is already TIMESTAMPTZ.
ALTER TABLE dead_letter_events
  ALTER COLUMN created_at TYPE TIMESTAMPTZ
  USING created_at AT TIME ZONE 'UTC';

-- Ensure NOT NULL matches the canonical definition. The runtime DDL used
-- DEFAULT NOW() without NOT NULL, so existing rows always have a value, but
-- the constraint was absent from the column definition.
ALTER TABLE dead_letter_events
  ALTER COLUMN created_at SET NOT NULL;

-- ── Indexes (idempotent via IF NOT EXISTS) ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_ledger
  ON dead_letter_events(ledger_seq DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letter_events_created_at
  ON dead_letter_events(created_at ASC);

COMMIT;
