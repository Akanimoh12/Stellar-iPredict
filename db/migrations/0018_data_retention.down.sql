-- Down: 0018_data_retention
--
-- Note: the archive_old_events() repair is intentionally NOT reverted — the
-- 0013 version is non-functional, so restoring it would only reintroduce a bug.

BEGIN;

DROP FUNCTION IF EXISTS enforce_data_retention();
DROP FUNCTION IF EXISTS purge_stale_oracle_submissions(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS purge_idempotency_keys(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS purge_events_archive(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS purge_dead_letter_events(INTEGER, INTEGER);
DROP TABLE IF EXISTS data_retention_policies;

COMMIT;
