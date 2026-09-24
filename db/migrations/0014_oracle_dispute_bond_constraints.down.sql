ALTER TABLE oracle_disputes
  DROP CONSTRAINT IF EXISTS ck_oracle_disputes_challenger_bond_gt_submitter,
  DROP CONSTRAINT IF EXISTS ck_oracle_disputes_challenger_bond_positive,
  DROP CONSTRAINT IF EXISTS ck_oracle_disputes_submitter_bond_positive;
