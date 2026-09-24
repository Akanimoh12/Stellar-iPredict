-- Migration: 0014_oracle_providers
-- Description: Add oracle_providers table for registered oracle provider enforcement (#438).

CREATE TABLE oracle_providers (
    address VARCHAR(64) PRIMARY KEY,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE oracle_providers IS 'Registered oracle providers authorized to submit outcomes. Providers must be active to submit.';
