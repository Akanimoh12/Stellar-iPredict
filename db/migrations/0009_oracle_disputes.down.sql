-- Down migration: 0009_oracle_disputes.down
-- Reverts 0009_oracle_disputes.sql

DROP TABLE IF EXISTS oracle_disputes;

DROP TYPE IF EXISTS oracle_dispute_status;