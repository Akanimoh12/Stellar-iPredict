-- Migration: 0022_oracle_resolution_lag
-- Issue #451: persist resolution-lag observations independently of process memory.

BEGIN;

CREATE TABLE oracle_resolution_lag (
  market_id          BIGINT PRIMARY KEY REFERENCES markets(id) ON DELETE RESTRICT,
  end_time           BIGINT NOT NULL,
  resolved_at_epoch  BIGINT NOT NULL,
  lag_hours          DOUBLE PRECISION NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX oracle_resolution_lag_resolved_at_idx
  ON oracle_resolution_lag (resolved_at_epoch DESC);

COMMENT ON TABLE oracle_resolution_lag IS
  'Issue #451: durable resolution-lag observations written after finalization commits; retained for 400 days.';

INSERT INTO data_retention_policies
  (category, target, class, retention, enforcement, justification)
VALUES
  ('oracle_resolution_lag',
   'oracle_resolution_lag',
   'operational',
   INTERVAL '400 days',
   'purge_oracle_resolution_lag()',
   'Historical aggregator performance used by dashboards; older observations are outside the operational reporting window.')
ON CONFLICT (category) DO UPDATE SET
  target = EXCLUDED.target,
  class = EXCLUDED.class,
  retention = EXCLUDED.retention,
  enforcement = EXCLUDED.enforcement,
  justification = EXCLUDED.justification,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION purge_oracle_resolution_lag(
  retention_days INTEGER DEFAULT 400,
  batch_size INTEGER DEFAULT 10000
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE removed INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT market_id
    FROM oracle_resolution_lag
    WHERE created_at < NOW() - (retention_days || ' days')::interval
    ORDER BY created_at ASC
    LIMIT batch_size
  )
  DELETE FROM oracle_resolution_lag WHERE market_id IN (SELECT market_id FROM doomed);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_data_retention()
RETURNS TABLE(category TEXT, rows_removed INTEGER) LANGUAGE plpgsql AS $$
BEGIN
  category := 'events_hot';                  rows_removed := archive_old_events(30, 10000);        RETURN NEXT;
  category := 'events_archive';              rows_removed := purge_events_archive(400, 10000);     RETURN NEXT;
  category := 'dead_letter_events';          rows_removed := purge_dead_letter_events(90, 5000);   RETURN NEXT;
  category := 'idempotency_keys';            rows_removed := purge_idempotency_keys(24, 5000);     RETURN NEXT;
  category := 'oracle_submissions_rejected'; rows_removed := purge_stale_oracle_submissions(180, 2000); RETURN NEXT;
  category := 'oracle_resolution_lag';       rows_removed := purge_oracle_resolution_lag(400, 10000); RETURN NEXT;
END;
$$;

COMMIT;
