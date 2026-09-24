-- Down: 0017_oracle_outcome_canonical (issue #650)
-- Drops the CHECK constraint. The up-migration's data normalisation
-- ('yes'/'true'/... -> 'YES') is intentionally NOT reversed — the canonical
-- values are strictly better and downstream tallying expects them.
ALTER TABLE oracle_submissions
  DROP CONSTRAINT IF EXISTS ck_oracle_submissions_outcome_canonical;
