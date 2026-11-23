BEGIN;

DROP FUNCTION IF EXISTS purge_oracle_resolution_lag(INTEGER, INTEGER);
DELETE FROM data_retention_policies WHERE category = 'oracle_resolution_lag';
DROP TABLE IF EXISTS oracle_resolution_lag;

CREATE OR REPLACE FUNCTION enforce_data_retention()
RETURNS TABLE(category TEXT, rows_removed INTEGER) LANGUAGE plpgsql AS $$
BEGIN
	category := 'events_hot';                  rows_removed := archive_old_events(30, 10000);        RETURN NEXT;
	category := 'events_archive';              rows_removed := purge_events_archive(400, 10000);     RETURN NEXT;
	category := 'dead_letter_events';          rows_removed := purge_dead_letter_events(90, 5000);   RETURN NEXT;
	category := 'idempotency_keys';            rows_removed := purge_idempotency_keys(24, 5000);     RETURN NEXT;
	category := 'oracle_submissions_rejected'; rows_removed := purge_stale_oracle_submissions(180, 2000); RETURN NEXT;
END;
$$;

COMMIT;
