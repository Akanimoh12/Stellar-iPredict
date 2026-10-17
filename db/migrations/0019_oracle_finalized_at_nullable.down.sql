-- Down migration for 0019_oracle_finalized_at_nullable
-- Restores the (buggy) default. Does not un-backfill: the NULLs written by
-- the up-migration are the correct values, and re-populating them with
-- CURRENT_TIMESTAMP would reintroduce the exact bug this migration fixes.

ALTER TABLE oracle_submissions ALTER COLUMN finalized_at SET DEFAULT CURRENT_TIMESTAMP;
