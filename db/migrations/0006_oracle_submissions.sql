-- Migration: 0006_oracle_submissions
-- Description: Creates the oracle_submissions table for tracking oracle activity.

CREATE TYPE oracle_submission_status AS ENUM (
    'submitted',
    'challenged',
    'finalized',
    'rejected'
);

CREATE TABLE oracle_submissions (
    id SERIAL PRIMARY KEY,
    market_id INTEGER NOT NULL,
    submitter VARCHAR(255) NOT NULL,
    outcome VARCHAR(255) NOT NULL,
    bond_amount NUMERIC NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status oracle_submission_status NOT NULL DEFAULT 'submitted'
);

CREATE INDEX idx_oracle_submissions_market_id ON oracle_submissions(market_id);
CREATE INDEX idx_oracle_submissions_status ON oracle_submissions(status);
