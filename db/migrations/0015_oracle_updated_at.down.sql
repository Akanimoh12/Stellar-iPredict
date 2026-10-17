DROP TRIGGER IF EXISTS trg_oracle_disputes_updated_at ON oracle_disputes;
DROP TRIGGER IF EXISTS trg_oracle_submissions_updated_at ON oracle_submissions;
ALTER TABLE oracle_disputes DROP COLUMN IF EXISTS updated_at;
ALTER TABLE oracle_submissions DROP COLUMN IF EXISTS updated_at;
DROP FUNCTION IF EXISTS set_updated_at();
