DROP INDEX IF EXISTS idx_bets_claimed_created_at;
DROP INDEX IF EXISTS idx_bets_market_created_at;
DROP INDEX IF EXISTS idx_bets_bettor_created_at;

CREATE INDEX IF NOT EXISTS idx_bets_bettor ON bets(bettor);