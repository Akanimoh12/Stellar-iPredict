-- Migration: 0030_bet_lookup_indexes
-- Cover frequent user, market, and claimed-status bet lookups and ordering.

DROP INDEX IF EXISTS idx_bets_bettor;

CREATE INDEX idx_bets_bettor_created_at
  ON bets (bettor, created_at DESC);

CREATE INDEX idx_bets_market_created_at
  ON bets (market_id, created_at DESC);

CREATE INDEX idx_bets_claimed_created_at
  ON bets (claimed, created_at DESC);