-- Migration: 0031_bet_oracle_constraints (rollback)

BEGIN;

ALTER TABLE oracle_submissions
  DROP CONSTRAINT IF EXISTS ck_oracle_submissions_bond_nonnegative,
  ALTER COLUMN submitted_at DROP NOT NULL;

ALTER TABLE bets
  DROP CONSTRAINT IF EXISTS ck_bets_net_amount_lte_gross,
  DROP CONSTRAINT IF EXISTS ck_bets_gross_amount_nonnegative,
  DROP CONSTRAINT IF EXISTS ck_bets_net_amount_nonnegative;

COMMIT;
