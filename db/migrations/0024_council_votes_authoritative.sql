-- Migration: 0024_council_votes_authoritative
-- Issue #454: document the durable council vote source of truth.

COMMENT ON TABLE council_votes IS
  'Authoritative current council vote per market and member. Writes use an upsert on the primary key; readers tally these rows rather than process-local vote state.';