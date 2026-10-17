-- Migration: 0017_oracle_outcome_canonical
-- Issue #650: constrain oracle_submissions.outcome to the canonical binary set.
--
-- Markets are binary. The API used to accept `outcome` as any non-empty string
-- (or a boolean coerced to "true"/"false"), so the column could hold "maybe",
-- "YES " or "true". Canonical form is now uppercase 'YES' / 'NO'.
--
-- This migration (1) migrates existing rows to the canonical form, (2) reports
-- any value it could not map, and (3) adds a CHECK so no write path can store
-- a non-canonical value. Run `tsx backend/scripts/audit-oracle-outcomes.ts`
-- against a copy first to see what will change.

BEGIN;

-- 1. Normalise the recognised spellings.
UPDATE oracle_submissions
SET outcome = 'YES'
WHERE outcome IS NOT NULL
  AND lower(btrim(outcome)) IN ('yes', 'y', 'true', '1');

UPDATE oracle_submissions
SET outcome = 'NO'
WHERE outcome IS NOT NULL
  AND lower(btrim(outcome)) IN ('no', 'n', 'false', '0');

-- 2. Fail loudly if anything is left that we cannot map — the operator must
--    decide (correct it, or delete the bad submission) before the constraint
--    can be added. This keeps the migration from silently dropping data.
DO $$
DECLARE
  bad_count integer;
  sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT quote_literal(outcome), ', ')
    INTO bad_count, sample
  FROM oracle_submissions
  WHERE outcome IS NULL OR outcome NOT IN ('YES', 'NO');

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'oracle_submissions has % row(s) with a non-canonical outcome that could not be auto-mapped: %. Resolve them (see backend/scripts/audit-oracle-outcomes.ts) then re-run.',
      bad_count, sample;
  END IF;
END $$;

-- 3. Enforce the invariant regardless of the write path.
ALTER TABLE oracle_submissions
  ADD CONSTRAINT ck_oracle_submissions_outcome_canonical
  CHECK (outcome IN ('YES', 'NO'));

COMMIT;
