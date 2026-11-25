-- Migration: 0028_adapter_raw_payloads (rollback)
--
-- Drops the raw-payload evidence table and its retention policy entry.
--
-- WARNING: this is destructive and unrecoverable. These rows are the only
-- record of what providers returned at resolution time; once dropped, a dispute
-- about an already-finalized market can no longer be evidenced. Prefer
-- exporting via the council audit tooling before rolling back.

BEGIN;

DROP INDEX IF EXISTS idx_adapter_raw_payloads_market;
DROP INDEX IF EXISTS idx_adapter_raw_payloads_provider;

DROP TABLE IF EXISTS adapter_raw_payloads;

DELETE FROM data_retention_policies WHERE category = 'adapter_raw_payloads';

DROP FUNCTION IF EXISTS max_raw_payload_bytes();

COMMIT;
