-- Migration: 0027_dead_letter_reprocessing
-- Issue #496: add columns to dead_letter_events to support safe reprocessing,
-- attempt tracking, and resolved marking.
--
-- New columns:
--   attempt_count  — how many times this event has been replayed. Starts at 0
--                    (never replayed). Incremented atomically before each replay
--                    attempt so the count reflects tries, not successes.
--   last_error     — the error message from the most recent failed attempt.
--                    NULL until the first replay is attempted. On success the
--                    row is marked resolved_at rather than this being cleared,
--                    preserving the last failure for triage.
--   resolved_at    — set to NOW() when the event is successfully replayed.
--                    NULL means unresolved. A resolved row is kept for the
--                    normal retention window (90 days) so the audit trail is
--                    preserved; it is excluded from the active queue.
--
-- Indexes:
--   idx_dead_letter_events_unresolved — partial index on unresolved rows only,
--                                       used by the reprocess queue scan.

BEGIN;

ALTER TABLE dead_letter_events
  ADD COLUMN IF NOT EXISTS attempt_count INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error    TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at   TIMESTAMPTZ;

-- Partial index for the active (unresolved) queue scan — avoids a full table
-- scan on every reprocess run once the majority of rows are resolved.
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_unresolved
  ON dead_letter_events(created_at ASC)
  WHERE resolved_at IS NULL;

COMMIT;
