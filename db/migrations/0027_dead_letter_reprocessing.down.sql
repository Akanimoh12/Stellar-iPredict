-- Migration: 0027_dead_letter_reprocessing (rollback)

BEGIN;

DROP INDEX IF EXISTS idx_dead_letter_events_unresolved;

ALTER TABLE dead_letter_events
  DROP COLUMN IF EXISTS resolved_at,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS attempt_count;

COMMIT;
