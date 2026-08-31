-- Migration: 0012_add_nonce_timestamp_to_oracle
-- Description: Add nonce and timestamp fields for replay protection.

ALTER TABLE oracle_submissions
    ADD COLUMN IF NOT EXISTS nonce VARCHAR(64),
    ADD COLUMN IF NOT EXISTS request_timestamp TIMESTAMPTZ;

-- Index for nonce lookups to prevent replay attacks
CREATE INDEX IF NOT EXISTS idx_oracle_submissions_nonce ON oracle_submissions(nonce) WHERE nonce IS NOT NULL;

-- For efficient cleanup of expired nonces
CREATE INDEX IF NOT EXISTS idx_oracle_submissions_request_timestamp ON oracle_submissions(request_timestamp) WHERE request_timestamp IS NOT NULL;
