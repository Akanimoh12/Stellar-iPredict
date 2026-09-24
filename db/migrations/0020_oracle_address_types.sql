-- Migration: 0020_oracle_address_types
-- Issue #408: oracle_submissions.submitter and oracle_disputes.submitter /
-- challenger are VARCHAR(255), while council_votes.member already uses
-- CHAR(56) for the same kind of value (a Stellar wallet address, always
-- exactly 56 characters). The loose VARCHAR(255) type lets malformed
-- addresses reach the database.
--
-- Chose CHAR(56) over VARCHAR(56) + a length CHECK: CHAR(56) only pads a
-- value shorter than 56 characters, and a valid Stellar address is always
-- exactly 56 -- so it never pads in practice, and matches the type already
-- used by council_votes.member, markets.creator, and bets.bettor, keeping
-- every wallet-address column in the schema directly comparable without a
-- cast. A CHECK constraint (not the column type) is what actually enforces
-- the address *shape* below.

BEGIN;

-- 1. Report (never silently drop) any existing row whose address would
--    violate the new shape, mirroring the pattern in
--    0017_oracle_outcome_canonical.sql. The regex matches
--    backend/src/api/profile.ts's STELLAR_ADDRESS_REGEX: a 'G'-prefixed
--    56-character base32 (RFC4648, A-Z2-7) string.
DO $$
DECLARE
  bad_submissions text;
  bad_disputes_submitter text;
  bad_disputes_challenger text;
BEGIN
  SELECT string_agg(DISTINCT quote_literal(submitter), ', ')
    INTO bad_submissions
  FROM oracle_submissions
  WHERE submitter IS NULL OR submitter !~ '^G[A-Z2-7]{55}$';

  SELECT string_agg(DISTINCT quote_literal(submitter), ', ')
    INTO bad_disputes_submitter
  FROM oracle_disputes
  WHERE submitter IS NULL OR submitter !~ '^G[A-Z2-7]{55}$';

  SELECT string_agg(DISTINCT quote_literal(challenger), ', ')
    INTO bad_disputes_challenger
  FROM oracle_disputes
  WHERE challenger IS NULL OR challenger !~ '^G[A-Z2-7]{55}$';

  IF bad_submissions IS NOT NULL THEN
    RAISE EXCEPTION
      'oracle_submissions has row(s) with a non-Stellar-address submitter: %. Resolve them (correct or delete the row) then re-run.',
      bad_submissions;
  END IF;
  IF bad_disputes_submitter IS NOT NULL THEN
    RAISE EXCEPTION
      'oracle_disputes has row(s) with a non-Stellar-address submitter: %. Resolve them then re-run.',
      bad_disputes_submitter;
  END IF;
  IF bad_disputes_challenger IS NOT NULL THEN
    RAISE EXCEPTION
      'oracle_disputes has row(s) with a non-Stellar-address challenger: %. Resolve them then re-run.',
      bad_disputes_challenger;
  END IF;
END $$;

-- 2. Tighten the column types.
ALTER TABLE oracle_submissions ALTER COLUMN submitter TYPE CHAR(56);
ALTER TABLE oracle_disputes ALTER COLUMN submitter TYPE CHAR(56);
ALTER TABLE oracle_disputes ALTER COLUMN challenger TYPE CHAR(56);

-- 3. Enforce the address shape regardless of write path.
ALTER TABLE oracle_submissions
  ADD CONSTRAINT ck_oracle_submissions_submitter_address
  CHECK (submitter ~ '^G[A-Z2-7]{55}$');

ALTER TABLE oracle_disputes
  ADD CONSTRAINT ck_oracle_disputes_submitter_address
  CHECK (submitter ~ '^G[A-Z2-7]{55}$');

ALTER TABLE oracle_disputes
  ADD CONSTRAINT ck_oracle_disputes_challenger_address
  CHECK (challenger ~ '^G[A-Z2-7]{55}$');

-- 4. outcome column review (#408 acceptance criterion). oracle_submissions
--    .outcome is already constrained to the canonical 'YES'/'NO' set by
--    ck_oracle_submissions_outcome_canonical (migration 0017, issue #650).
--    oracle_disputes.outcome carries the same disputed-outcome semantics
--    but was never canonicalized -- bring it in line the same way: normalise
--    recognised spellings, fail loudly (not silently) on anything left over,
--    then enforce with a matching CHECK.
UPDATE oracle_disputes
SET outcome = 'YES'
WHERE outcome IS NOT NULL AND lower(btrim(outcome)) IN ('yes', 'y', 'true', '1');

UPDATE oracle_disputes
SET outcome = 'NO'
WHERE outcome IS NOT NULL AND lower(btrim(outcome)) IN ('no', 'n', 'false', '0');

DO $$
DECLARE
  bad_count integer;
  sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT quote_literal(outcome), ', ')
    INTO bad_count, sample
  FROM oracle_disputes
  WHERE outcome IS NULL OR outcome NOT IN ('YES', 'NO');

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'oracle_disputes has % row(s) with a non-canonical outcome that could not be auto-mapped: %. Resolve them then re-run.',
      bad_count, sample;
  END IF;
END $$;

ALTER TABLE oracle_disputes
  ADD CONSTRAINT ck_oracle_disputes_outcome_canonical
  CHECK (outcome IN ('YES', 'NO'));

COMMENT ON COLUMN oracle_submissions.outcome IS
  'Canonical binary outcome: ''YES'' or ''NO''. Enforced by ck_oracle_submissions_outcome_canonical (#650).';
COMMENT ON COLUMN oracle_disputes.outcome IS
  'Disputed/proposed canonical binary outcome: ''YES'' or ''NO''. Enforced by ck_oracle_disputes_outcome_canonical (#408).';

COMMIT;
