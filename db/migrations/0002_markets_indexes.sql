-- Adds indexes to speed up market list queries filtering by category and state
BEGIN;

-- index on category for quick category lookups
CREATE INDEX IF NOT EXISTS idx_markets_category
ON markets (category);

-- index for resolved queries; include end_time for ordering/filters
CREATE INDEX IF NOT EXISTS idx_markets_resolved
ON markets (resolved, end_time);

-- index for active markets: unresolved and not cancelled
CREATE INDEX IF NOT EXISTS idx_markets_active
ON markets (resolved, cancelled, end_time);

COMMIT;
