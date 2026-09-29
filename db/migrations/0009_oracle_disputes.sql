-- Migration: 0009_oracle_disputes
-- Description: Creates the oracle_disputes table for tracking challenged /
-- escalated optimistic-oracle submissions (see docs/ORACLE_AND_BACKEND.md).

CREATE TYPE oracle_dispute_status AS ENUM (
    'challenged',
    'escalated'
);

CREATE TABLE oracle_disputes (
    id SERIAL PRIMARY KEY,
    market_id INTEGER NOT NULL,
    submitter VARCHAR(255) NOT NULL,
    challenger VARCHAR(255) NOT NULL,
    outcome VARCHAR(255) NOT NULL,
    submitter_bond NUMERIC NOT NULL,
    challenger_bond NUMERIC NOT NULL,
    total_bond NUMERIC,
    status oracle_dispute_status NOT NULL DEFAULT 'challenged',
    challenged_at TIMESTAMPTZ,
    escalated_at TIMESTAMPTZ,
    council_deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_oracle_disputes_market_id UNIQUE (market_id)
);

CREATE INDEX idx_oracle_disputes_status ON oracle_disputes(status);
