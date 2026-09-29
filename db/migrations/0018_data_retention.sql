-- Migration: 0018_data_retention
-- Issue #646: define and enforce retention for every category of data that
-- otherwise grows without bound.
--
-- Two classes of data, deliberately treated differently:
--
--   operational  — needed to run the platform day to day. Safe to delete once
--                  it is old enough that nothing reads it. Enforced by
--                  enforce_data_retention() on a schedule.
--   audit        — the record of how a market was resolved and disputed. A
--                  dispute or inquiry can surface long after the event, so
--                  these are kept for a long, deliberately-set window and are
--                  NEVER touched by the operational purge.
--
-- The policy itself is documented in docs/DATA-RETENTION.md. This table is the
-- machine-readable copy so it can be inspected from a psql prompt.

BEGIN;

CREATE TABLE IF NOT EXISTS data_retention_policies (
  category            TEXT PRIMARY KEY,
  target              TEXT NOT NULL,           -- table / column the policy covers
  class               TEXT NOT NULL CHECK (class IN ('operational', 'audit')),
  retention           INTERVAL NOT NULL,
  enforcement         TEXT NOT NULL,           -- function or process that applies it
  justification       TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE data_retention_policies IS
  'Issue #646: retention period + justification for every data category. See docs/DATA-RETENTION.md.';

INSERT INTO data_retention_policies (category, target, class, retention, enforcement, justification) VALUES
  ('events_hot',
   'events',
   'operational',
   INTERVAL '30 days',
   'archive_old_events() — moves rows to events_archive',
   'Replay and backfill only need recent events in the hot table; older rows are archived, not lost.'),

  ('events_archive',
   'events_archive',
   'operational',
   INTERVAL '400 days',
   'purge_events_archive()',
   'Bounds archive growth. Set >= the RPC event-retention window so chain replay plus the archive together cover all reconstructible state; older state is recovered from backups (issue #648), not chain.'),

  ('dead_letter_events',
   'dead_letter_events',
   'operational',
   INTERVAL '90 days',
   'purge_dead_letter_events()',
   'Decode failures exist to debug the indexer. 90 days is enough to notice, fix, and re-drive; after that they carry no value.'),

  ('idempotency_keys',
   'idempotency_keys',
   'operational',
   INTERVAL '24 hours',
   'purge_idempotency_keys() (hard ceiling; app also prunes at ORACLE_IDEMPOTENCY_RETENTION_SEC)',
   'Retry-deduplication cache. Clients do not retry a submission a day later.'),

  ('oracle_nonces',
   'oracle_submissions (rows with a nonce)',
   'operational',
   INTERVAL '10 minutes',
   'cleanupExpiredNonces() (backend, ORACLE_NONCE_RETENTION_SEC)',
   'Replay-protection window only.'),

  ('oracle_submissions_rejected',
   'oracle_submissions WHERE status = ''rejected'' AND no dispute',
   'operational',
   INTERVAL '180 days',
   'purge_stale_oracle_submissions()',
   'A rejected submission that was never challenged has no audit weight after ~two quarters.'),

  ('oracle_submissions_finalized',
   'oracle_submissions WHERE status = ''finalized''',
   'audit',
   INTERVAL '7 years',
   'MANUAL — legal review only; excluded from enforce_data_retention()',
   'The record of how a market resolved. A dispute or legal inquiry can surface years later.'),

  ('council_votes',
   'council_votes',
   'audit',
   INTERVAL '7 years',
   'MANUAL — legal review only; excluded from enforce_data_retention()',
   'Shows which council member voted which outcome on a resolution — primary dispute evidence.'),

  ('oracle_disputes',
   'oracle_disputes',
   'audit',
   INTERVAL '7 years',
   'MANUAL — legal review only; excluded from enforce_data_retention()',
   'The dispute record itself. Retention is bounded by the longest plausible dispute/appeal window.')
ON CONFLICT (category) DO UPDATE SET
  target        = EXCLUDED.target,
  class         = EXCLUDED.class,
  retention     = EXCLUDED.retention,
  enforcement   = EXCLUDED.enforcement,
  justification = EXCLUDED.justification,
  updated_at    = NOW();

-- ── Repair archive_old_events (from 0013) ──────────────────────────────────
-- The 0013 version never actually ran: its final `DELETE ... RETURNING 1` has
-- no INTO target ("query has no destination for result data"), and it deleted
-- `WHERE id IN (SELECT id FROM archived)` where `archived` returned
-- events_archive ids, not events ids. Nothing called it in automation so the
-- bug went unnoticed until enforce_data_retention() below. This rewrite:
--   * captures the row count via a `deleted` CTE + `SELECT count(*) INTO`
--   * deletes the rows it selected (all of which are in events_archive after
--     the ON CONFLICT DO NOTHING insert), so archival actually progresses.
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
    INSERT INTO events_archive (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload, created_at)
    SELECT ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload, created_at
    FROM rows_to_archive
    ON CONFLICT (tx_hash, event_index) DO NOTHING
  ),
  deleted AS (
    DELETE FROM events
    WHERE id IN (SELECT id FROM rows_to_archive)
    RETURNING id
  )
  SELECT count(*) INTO moved_count FROM deleted;

  RETURN moved_count;
END;
$$;

-- ── Operational purge functions ─────────────────────────────────────────────
-- All are batched so they never hold a long write lock, and all return the
-- number of rows removed so the caller can log it.

CREATE OR REPLACE FUNCTION purge_dead_letter_events(retention_days INTEGER DEFAULT 90, batch_size INTEGER DEFAULT 5000)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE removed INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT id FROM dead_letter_events
    WHERE created_at < NOW() - (retention_days || ' days')::interval
    ORDER BY created_at ASC
    LIMIT batch_size
  )
  DELETE FROM dead_letter_events WHERE id IN (SELECT id FROM doomed);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION purge_events_archive(retention_days INTEGER DEFAULT 400, batch_size INTEGER DEFAULT 10000)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE removed INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT id FROM events_archive
    WHERE created_at < NOW() - (retention_days || ' days')::interval
    ORDER BY created_at ASC
    LIMIT batch_size
  )
  DELETE FROM events_archive WHERE id IN (SELECT id FROM doomed);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION purge_idempotency_keys(retention_hours INTEGER DEFAULT 24, batch_size INTEGER DEFAULT 5000)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE removed INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT idempotency_key FROM idempotency_keys
    WHERE created_at < NOW() - (retention_hours || ' hours')::interval
    ORDER BY created_at ASC
    LIMIT batch_size
  )
  DELETE FROM idempotency_keys WHERE idempotency_key IN (SELECT idempotency_key FROM doomed);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- Only rejected submissions that never became a dispute. Finalized submissions
-- are audit-class and are never removed here.
CREATE OR REPLACE FUNCTION purge_stale_oracle_submissions(retention_days INTEGER DEFAULT 180, batch_size INTEGER DEFAULT 2000)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE removed INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT s.id
    FROM oracle_submissions s
    LEFT JOIN oracle_disputes d ON d.market_id = s.market_id
    WHERE s.status = 'rejected'
      AND d.id IS NULL
      AND COALESCE(s.finalized_at, s.submitted_at) < NOW() - (retention_days || ' days')::interval
    ORDER BY s.id ASC
    LIMIT batch_size
  )
  DELETE FROM oracle_submissions WHERE id IN (SELECT id FROM doomed);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- ── Orchestrator ───────────────────────────────────────────────────────────
-- Applies every operational policy once and returns a per-category row count.
-- Audit-class categories are intentionally absent. Run this on a schedule
-- (see infra/README.md § "Data retention" and docs/DATA-RETENTION.md).

CREATE OR REPLACE FUNCTION enforce_data_retention()
RETURNS TABLE(category TEXT, rows_removed INTEGER) LANGUAGE plpgsql AS $$
BEGIN
  category := 'events_hot';                  rows_removed := archive_old_events(30, 10000);        RETURN NEXT;
  category := 'events_archive';              rows_removed := purge_events_archive(400, 10000);     RETURN NEXT;
  category := 'dead_letter_events';          rows_removed := purge_dead_letter_events(90, 5000);   RETURN NEXT;
  category := 'idempotency_keys';            rows_removed := purge_idempotency_keys(24, 5000);     RETURN NEXT;
  category := 'oracle_submissions_rejected'; rows_removed := purge_stale_oracle_submissions(180, 2000); RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION enforce_data_retention() IS
  'Issue #646: applies all operational retention policies in bounded batches. Audit-class data (finalized oracle_submissions, council_votes, oracle_disputes) is deliberately excluded.';

COMMIT;
