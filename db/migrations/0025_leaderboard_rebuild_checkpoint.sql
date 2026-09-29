-- Migration to add leaderboard rebuild checkpoint table
-- This table tracks progress during leaderboard rebuilds for resumability

CREATE TABLE IF NOT EXISTS leaderboard_rebuild_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_processed_ledger BIGINT NOT NULL,
    event_count BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE leaderboard_rebuild_checkpoint IS 'Tracks progress of leaderboard rebuild jobs for resumability after failures';
COMMENT ON COLUMN leaderboard_rebuild_checkpoint.id IS 'Singleton row ID (always 1)';
COMMENT ON COLUMN leaderboard_rebuild_checkpoint.last_processed_ledger IS 'Last ledger successfully processed during rebuild';
COMMENT ON COLUMN leaderboard_rebuild_checkpoint.event_count IS 'Number of events processed so far';
COMMENT ON COLUMN leaderboard_rebuild_checkpoint.updated_at IS 'Last checkpoint update timestamp';
