-- Migration: 0015_idempotency_keys
-- Description: Add idempotency_keys table for safe oracle submission retries (#441).

CREATE TABLE idempotency_keys (
    idempotency_key VARCHAR(128) PRIMARY KEY,
    payload_hash VARCHAR(64) NOT NULL,
    response_body JSONB NOT NULL,
    status_code INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys(created_at);

COMMENT ON TABLE idempotency_keys IS 'Stores idempotent oracle submission responses for safe retries within a bounded retention window.';
