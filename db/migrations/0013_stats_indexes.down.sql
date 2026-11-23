-- Rollback: 0013_stats_indexes

BEGIN;

DROP INDEX IF EXISTS idx_markets_volume;

COMMIT;
