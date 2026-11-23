CREATE TABLE bets (
  market_id   BIGINT REFERENCES markets(id),
  bettor      CHAR(56) NOT NULL,
  net_amount  NUMERIC(30,7) NOT NULL,
  gross_amount NUMERIC(30,7) NOT NULL,
  is_yes      BOOLEAN NOT NULL,
  claimed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (market_id, bettor)
);

CREATE INDEX idx_bets_bettor ON bets(bettor);
