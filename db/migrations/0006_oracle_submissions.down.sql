-- Down migration: 0006_oracle_submissions.down
-- Reverts 0006_oracle_submissions.sql

DROP TABLE IF EXISTS oracle_submissions;

DROP TYPE IF EXISTS oracle_submission_status;