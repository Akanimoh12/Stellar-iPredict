-- Migration: 0001_create_markets
-- Description: Creates the markets table for storing indexed on-chain market data.

CREATE TABLE IF NOT EXISTS markets (
  id            BIGINT PRIMARY KEY,
  question      TEXT NOT NULL,
  image_url     TEXT,
  category      VARCHAR(20) NOT NULL,
  end_time      BIGINT NOT NULL,
  total_yes     NUMERIC(30,7) NOT NULL DEFAULT 0,
  total_no      NUMERIC(30,7) NOT NULL DEFAULT 0,
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  outcome       BOOLEAN,
  cancelled     BOOLEAN NOT NULL DEFAULT FALSE,
  creator       CHAR(56) NOT NULL,
  bet_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
CREATE INDEX IF NOT EXISTS idx_markets_resolved ON markets(resolved, end_time);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(resolved, cancelled, end_time);
