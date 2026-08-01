-- Migration: 0008_council_votes
-- Description: Creates the council_votes table for tracking each Phase 1.5
-- council member's submitted outcome per market. One row per (market, member)
-- so a member's vote can be updated but never double-counted.

CREATE TABLE council_votes (
    market_id BIGINT NOT NULL,
    member CHAR(56) NOT NULL,
    outcome BOOLEAN NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (market_id, member)
);

CREATE INDEX idx_council_votes_market_id ON council_votes(market_id);
