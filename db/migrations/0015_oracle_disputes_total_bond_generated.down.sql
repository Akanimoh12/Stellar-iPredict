-- Down migration: 0015_oracle_disputes_total_bond_generated.down
-- Reverts 0015_oracle_disputes_total_bond_generated.sql

ALTER TABLE oracle_disputes
    DROP COLUMN IF EXISTS total_bond;

ALTER TABLE oracle_disputes
    ADD COLUMN total_bond NUMERIC;
