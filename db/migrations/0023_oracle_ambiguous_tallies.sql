-- Migration: 0023_oracle_ambiguous_tallies
-- Issue #453: durable manual-review state for impossible ambiguous tallies.

BEGIN;

CREATE TABLE oracle_ambiguous_tallies (
  market_id         BIGINT PRIMARY KEY REFERENCES markets(id) ON DELETE RESTRICT,
  yes_votes         INTEGER NOT NULL,
  no_votes          INTEGER NOT NULL,
  threshold         INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'manual_review'
                    CHECK (status IN ('manual_review', 'cleared')),
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_claimed_at  TIMESTAMPTZ
);

CREATE INDEX oracle_ambiguous_tallies_pending_idx
  ON oracle_ambiguous_tallies (market_id)
  WHERE status = 'manual_review';

COMMENT ON TABLE oracle_ambiguous_tallies IS
  'Issue #453: markets whose council tally reached both outcomes; held for manual review until cleared.';

COMMIT;