-- Migration: 0029_dead_letter_retry_cap
-- Issue #931: keep permanently failing dead-letter rows out of the active queue.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_dead_letter_events_retryable
  ON dead_letter_events(created_at ASC)
  WHERE resolved_at IS NULL AND attempt_count < 10;

COMMIT;