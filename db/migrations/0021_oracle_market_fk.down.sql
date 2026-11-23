-- Down migration for 0021_oracle_market_fk
-- Does not restore deleted orphan rows -- their removal is the correct,
-- intended effect of the up-migration, not an incidental side effect to
-- reverse.

BEGIN;

ALTER TABLE council_votes DROP CONSTRAINT IF EXISTS fk_council_votes_market_id;
ALTER TABLE oracle_disputes DROP CONSTRAINT IF EXISTS fk_oracle_disputes_market_id;
ALTER TABLE oracle_submissions DROP CONSTRAINT IF EXISTS fk_oracle_submissions_market_id;

ALTER TABLE oracle_disputes ALTER COLUMN market_id TYPE INTEGER;
ALTER TABLE oracle_submissions ALTER COLUMN market_id TYPE INTEGER;

COMMIT;
