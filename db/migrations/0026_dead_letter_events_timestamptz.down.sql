-- Migration: 0026_dead_letter_events_timestamptz (rollback)
-- Reverts created_at from TIMESTAMPTZ back to TIMESTAMP.
-- The indexes added in the up migration are left in place because the
-- 0010 runtime DDL would have created them too; removing them here would
-- leave the schema in a worse state than before the 0010 path ran.

BEGIN;

ALTER TABLE dead_letter_events
  ALTER COLUMN created_at TYPE TIMESTAMP
  USING created_at AT TIME ZONE 'UTC';

COMMIT;
