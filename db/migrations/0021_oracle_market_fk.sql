-- Migration: 0021_oracle_market_fk
-- Issue #407: oracle_submissions.market_id, oracle_disputes.market_id, and
-- council_votes.market_id carry no foreign key to markets(id), so nothing
-- stops a row being recorded for a market that doesn't exist, and orphan
-- rows accumulate invisibly.
--
-- oracle_submissions.market_id and oracle_disputes.market_id are INTEGER
-- while markets.id and council_votes.market_id are BIGINT -- a foreign key
-- requires matching types, so both are widened to BIGINT (per guidance,
-- widening rather than narrowing council_votes/markets). Every read of
-- these columns in oracle/src already casts to `::text` before use
-- (submission-watcher.ts, bond-monitor.ts, bond-reconciliation.ts,
-- council-audit.ts, council-inactivity-monitor.ts, dispute-escalation-watcher.ts,
-- metrics/collector.ts), so widening the underlying column is invisible to
-- those call sites; the one exception
-- (backend/src/db/oracle.ts:recordOracleSubmission's RETURNING clause) is
-- updated in the same commit as this migration to match.

BEGIN;

-- 1. Widen market_id columns to BIGINT (matching markets.id / council_votes.market_id).
ALTER TABLE oracle_submissions ALTER COLUMN market_id TYPE BIGINT;
ALTER TABLE oracle_disputes ALTER COLUMN market_id TYPE BIGINT;

-- 2. Report (never silently drop) orphan rows -- ones referencing a
--    market_id with no corresponding markets row -- before deleting them. A
--    foreign key cannot be added while violations exist, and deleting
--    without a trace would hide real data loss from whoever runs this.
DO $$
DECLARE
  orphan_submissions bigint;
  orphan_disputes bigint;
  orphan_votes bigint;
  sample_submissions text;
  sample_disputes text;
  sample_votes text;
BEGIN
  SELECT count(*) INTO orphan_submissions
  FROM oracle_submissions s
  WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = s.market_id);
  SELECT string_agg(market_id::text, ', ') INTO sample_submissions
  FROM (
    SELECT DISTINCT s.market_id FROM oracle_submissions s
    WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = s.market_id)
    ORDER BY s.market_id LIMIT 20
  ) t(market_id);

  SELECT count(*) INTO orphan_disputes
  FROM oracle_disputes d
  WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = d.market_id);
  SELECT string_agg(market_id::text, ', ') INTO sample_disputes
  FROM (
    SELECT DISTINCT d.market_id FROM oracle_disputes d
    WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = d.market_id)
    ORDER BY d.market_id LIMIT 20
  ) t(market_id);

  SELECT count(*) INTO orphan_votes
  FROM council_votes v
  WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = v.market_id);
  SELECT string_agg(market_id::text, ', ') INTO sample_votes
  FROM (
    SELECT DISTINCT v.market_id FROM council_votes v
    WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = v.market_id)
    ORDER BY v.market_id LIMIT 20
  ) t(market_id);

  IF orphan_submissions > 0 THEN
    RAISE NOTICE 'Deleting % orphan oracle_submissions row(s) with no matching markets.id (sample: %)', orphan_submissions, sample_submissions;
  END IF;
  IF orphan_disputes > 0 THEN
    RAISE NOTICE 'Deleting % orphan oracle_disputes row(s) with no matching markets.id (sample: %)', orphan_disputes, sample_disputes;
  END IF;
  IF orphan_votes > 0 THEN
    RAISE NOTICE 'Deleting % orphan council_votes row(s) with no matching markets.id (sample: %)', orphan_votes, sample_votes;
  END IF;
END $$;

DELETE FROM oracle_submissions s
WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = s.market_id);

DELETE FROM oracle_disputes d
WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = d.market_id);

DELETE FROM council_votes v
WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.id = v.market_id);

-- 3. Add the foreign keys.
--
-- ON DELETE RESTRICT for all three: markets are an indexed copy of on-chain
-- state and this app never deletes a markets row as part of normal
-- operation (resolved/cancelled markets still need their oracle audit trail
-- -- see db/README.md's "Audit-class data ... retained for 7 years").
-- RESTRICT makes an attempt to delete a market with oracle history fail
-- loudly and immediately, instead of CASCADE silently destroying that
-- audit trail or SET NULL quietly orphaning it.
ALTER TABLE oracle_submissions
  ADD CONSTRAINT fk_oracle_submissions_market_id
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT;

ALTER TABLE oracle_disputes
  ADD CONSTRAINT fk_oracle_disputes_market_id
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT;

ALTER TABLE council_votes
  ADD CONSTRAINT fk_council_votes_market_id
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE RESTRICT;

COMMIT;
