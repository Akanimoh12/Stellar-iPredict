-- Migration: 0028_markets_sort_indexes (rollback)
-- Removes the three indexes added in 0028 and restores idx_markets_volume.

BEGIN;

DROP INDEX IF EXISTS idx_markets_created_at;
DROP INDEX IF EXISTS idx_markets_volume_tiebreak;
DROP INDEX IF EXISTS idx_markets_bettors;

-- Restore the pre-0028 volume index (no tiebreaker)
CREATE INDEX IF NOT EXISTS idx_markets_volume
  ON markets ((total_yes + total_no) DESC);

COMMIT;
