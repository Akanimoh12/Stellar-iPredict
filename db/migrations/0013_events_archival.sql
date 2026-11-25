-- Migration: 0013_events_archival
-- Description: Move stale event rows into an archive table in bounded batches to keep the hot events table within a replayable retention window.

CREATE TABLE IF NOT EXISTS events_archive (
  id BIGSERIAL PRIMARY KEY,
  ledger_seq BIGINT NOT NULL,
  tx_hash CHAR(64) NOT NULL,
  event_index BIGINT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  market_id BIGINT REFERENCES markets(id),
  actor CHAR(56),
  payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_archive_tx_hash_event_index
ON events_archive(tx_hash, event_index);

CREATE INDEX IF NOT EXISTS idx_events_archive_created_at
ON events_archive(created_at DESC);

CREATE OR REPLACE FUNCTION archive_old_events(retention_days INTEGER DEFAULT 30, batch_size INTEGER DEFAULT 10000)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  moved_count INTEGER := 0;
BEGIN
  WITH rows_to_archive AS (
    SELECT id, ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload, created_at
    FROM events
    WHERE created_at < NOW() - (retention_days || ' days')::interval
    ORDER BY created_at ASC
    LIMIT batch_size
  ),
  archived AS (
    INSERT INTO events_archive (
      ledger_seq,
      tx_hash,
      event_index,
      event_type,
      market_id,
      actor,
      payload,
      created_at
    )
    SELECT
      ledger_seq,
      tx_hash,
      event_index,
      event_type,
      market_id,
      actor,
      payload,
      created_at
    FROM rows_to_archive
    ON CONFLICT (tx_hash, event_index) DO NOTHING
    RETURNING id
  )
  DELETE FROM events
  WHERE id IN (SELECT id FROM archived)
  RETURNING 1;

  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RETURN moved_count;
END;
$$;

COMMENT ON TABLE events_archive IS 'Archive of older on-chain events retained for forensic replay and recovery, while keeping the hot events table within the replay retention window.';
COMMENT ON FUNCTION archive_old_events(INTEGER, INTEGER) IS 'Moves stale event rows from events to events_archive in bounded batches without holding long-lived write locks.';
