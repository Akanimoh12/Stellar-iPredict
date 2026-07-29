-- Migration: 0005_create_events
-- Description: Creates the events table for storing raw on-chain events for audit and replay.

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  ledger_seq  BIGINT NOT NULL,
  tx_hash     CHAR(64) NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  market_id   BIGINT REFERENCES markets(id),
  actor       CHAR(56),
  payload     JSONB,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_market_id ON events(market_id);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_ledger_seq ON events(ledger_seq DESC);
