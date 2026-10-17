-- Migration: 0014_oracle_dispute_bond_constraints
-- Contract constants: SUBMITTER_BOND and DISPUTER_BOND (DISPUTER_BOND > SUBMITTER_BOND).

DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM oracle_disputes
  WHERE submitter_bond <= 0 OR challenger_bond <= 0
     OR challenger_bond <= submitter_bond;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'oracle_disputes contains % invalid bond row(s); fix them before applying 0014', invalid_count;
  END IF;
END
$$;

ALTER TABLE oracle_disputes
  ADD CONSTRAINT ck_oracle_disputes_submitter_bond_positive CHECK (submitter_bond > 0),
  ADD CONSTRAINT ck_oracle_disputes_challenger_bond_positive CHECK (challenger_bond > 0),
  ADD CONSTRAINT ck_oracle_disputes_challenger_bond_gt_submitter CHECK (challenger_bond > submitter_bond);
