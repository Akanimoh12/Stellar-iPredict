-- Migration: 0015_oracle_disputes_total_bond_generated
-- Description: Convert oracle_disputes.total_bond from a nullable NUMERIC
-- that nothing maintained into a GENERATED column (see issue #412).

-- Decision (recorded for #412):
--
-- `total_bond` is NOT unused — a search of the backend, oracle and indexer
-- found two readers: the indexer writes it from the on-chain `escalated`
-- event (indexer/src/handlers/oracle_challenge.ts) and the council watcher
-- reads it back (oracle/src/aggregator/dispute-escalation-watcher.ts). So the
-- column earns its place.
--
-- However it must never be maintained by hand. The contract emits
-- `total_bond = submitter_bond + challenger_bond` (prediction_market contract,
-- `challenge()`), and the DB already stores both `submitter_bond` and
-- `challenger_bond` on insert. Deriving the column from those two is always
-- correct and can never drift from its inputs, so it is converted to a
-- `GENERATED ALWAYS ... STORED` column instead of being dropped.
--
-- The write path is updated in the indexer to stop feeding `total_bond`
-- explicitly: generated columns reject explicit INSERT/UPDATE writes.
--
-- Generated columns require PostgreSQL 12+ (satisfied here).

ALTER TABLE oracle_disputes
    DROP COLUMN IF EXISTS total_bond;

ALTER TABLE oracle_disputes
    ADD COLUMN total_bond NUMERIC
        GENERATED ALWAYS AS (submitter_bond + challenger_bond) STORED;
