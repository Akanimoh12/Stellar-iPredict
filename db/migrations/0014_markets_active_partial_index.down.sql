-- Down migration: 0014_markets_active_partial_index.down
-- Reverts 0014_markets_active_partial_index.sql

DROP INDEX IF EXISTS idx_markets_active_partial;
