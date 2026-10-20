-- Migration: 0031_bet_oracle_constraints
-- Add database-level validation for bet amounts and oracle submission records.

BEGIN;

DO $$
DECLARE
  invalid_bets BIGINT;
  missing_submission_times BIGINT;
  negative_submission_bonds BIGINT;
BEGIN
  SELECT count(*) INTO invalid_bets
  FROM bets
  WHERE net_amount < 0
     OR gross_amount < 0
     OR net_amount > gross_amount;

  IF invalid_bets > 0 THEN
    RAISE EXCEPTION
      'bets contains % row(s) with negative amounts or net_amount greater than gross_amount; correct them before re-running',
      invalid_bets;
  END IF;

  SELECT count(*) INTO missing_submission_times
  FROM oracle_submissions
  WHERE submitted_at IS NULL;

  IF missing_submission_times > 0 THEN
    RAISE EXCEPTION
      'oracle_submissions contains % row(s) without submitted_at; correct them before re-running',
      missing_submission_times;
  END IF;

  SELECT count(*) INTO negative_submission_bonds
  FROM oracle_submissions
  WHERE bond_amount < 0;

  IF negative_submission_bonds > 0 THEN
    RAISE EXCEPTION
      'oracle_submissions contains % row(s) with negative bond_amount; correct them before re-running',
      negative_submission_bonds;
  END IF;
END
$$;

ALTER TABLE bets
  ADD CONSTRAINT ck_bets_net_amount_nonnegative CHECK (net_amount >= 0),
  ADD CONSTRAINT ck_bets_gross_amount_nonnegative CHECK (gross_amount >= 0),
  ADD CONSTRAINT ck_bets_net_amount_lte_gross CHECK (net_amount <= gross_amount);

ALTER TABLE oracle_submissions
  ALTER COLUMN submitted_at SET NOT NULL,
  ADD CONSTRAINT ck_oracle_submissions_bond_nonnegative CHECK (bond_amount >= 0);

COMMIT;
