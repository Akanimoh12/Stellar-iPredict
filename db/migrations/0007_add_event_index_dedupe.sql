-- Migration: 0007_add_event_index_dedupe
-- Description: Adds event_index and enforces idempotent event writes by transaction hash plus event index.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_index BIGINT;

WITH indexed_events AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY tx_hash ORDER BY id) - 1 AS derived_event_index
  FROM events
  WHERE event_index IS NULL
)
UPDATE events
SET event_index = indexed_events.derived_event_index
FROM indexed_events
WHERE events.id = indexed_events.id;

ALTER TABLE events
  ALTER COLUMN event_index SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tx_hash_event_index
ON events(tx_hash, event_index);
