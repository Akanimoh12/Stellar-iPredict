-- Migration: 0013_stats_indexes
-- Description: Indexes to support stats aggregation and market volume operations.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets ((total_yes + total_no) DESC);

COMMIT;
