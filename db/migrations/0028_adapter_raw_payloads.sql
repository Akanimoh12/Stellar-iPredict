-- Migration: 0028_adapter_raw_payloads
--
-- Issue: `AdapterOutcome.raw` is documented as "Raw provider payload, kept for
-- audit/dispute review", but nothing persisted it. The payload lived only in
-- process memory, so during a dispute there was no record of what the provider
-- actually returned at resolution time — the single most useful piece of
-- evidence for contesting a decision.
--
-- This table makes that evidence durable. One row per (market, provider) fetch.
--
-- Design notes
-- ────────────
-- * WHY A SEPARATE TABLE. A resolution consults several providers, and each is
--   re-consulted on retry. A JSONB column on `oracle_submissions` would have to
--   be overwritten in place, destroying the earlier observation. Rows are
--   append-only instead, so the payload that was in hand at decision time is
--   never lost to a later re-fetch.
--
-- * COMPRESSION. `raw_response` is JSONB, which Postgres TOASTs and transparently
--   pglz-compresses once a value exceeds ~2KB — the case that matters, since
--   small payloads are the ones already cheap to store. Compressing by hand
--   would make the column opaque to SQL inspection and to the audit tooling
--   that has to read it. `response_bytes` records the *uncompressed* size so
--   growth is observable and the bound below is enforceable.
--
-- * BOUNDED STORAGE. A hostile or malfunctioning provider returning a
--   multi-megabyte body must not be able to fill the disk through the audit
--   path. `MAX_RAW_PAYLOAD_BYTES` caps what is accepted; callers that hit the
--   cap store a truncated payload and set `truncated = true` so the record
--   remains honest about being incomplete rather than silently partial.
--
-- * CREDENTIALS. Payloads are sanitized by the oracle before they reach here
--   (see `sanitizeProvenanceValue` in oracle/src/adapters/provenance.ts), which
--   redacts api keys, tokens and Authorization headers. This table is
--   audit-class and therefore read by council tooling and exports.

BEGIN;

-- 1 MiB. Generous for a ticker/score/news response; small enough that a
-- pathological provider cannot exhaust storage through the audit path.
CREATE OR REPLACE FUNCTION max_raw_payload_bytes() RETURNS INTEGER
  LANGUAGE sql IMMUTABLE AS $$ SELECT 1048576; $$;

CREATE TABLE IF NOT EXISTS adapter_raw_payloads (
  id            BIGSERIAL   PRIMARY KEY,

  -- Which market the fetch was for. Not a FK to markets: payload evidence must
  -- outlive the row it describes, and audit-class data is never cascade-purged.
  market_id     TEXT        NOT NULL,

  -- Provider identity: the adapter id (e.g. "binance", "reuters"). Required, so
  -- a payload can never be attributed to an anonymous or unknown source.
  provider      TEXT        NOT NULL,

  -- The request that produced this response (URL/params, redacted). Kept so a
  -- reviewer can tell "the provider said X" from "we asked the wrong question".
  raw_request   JSONB,

  -- The provider's response body, verbatim, after credential redaction.
  raw_response  JSONB       NOT NULL,

  -- Uncompressed size of raw_response, recorded for observability and to
  -- enforce the bound above.
  response_bytes INTEGER     NOT NULL,

  -- Set when the payload hit MAX_RAW_PAYLOAD_BYTES and was stored shortened.
  -- A truncated record must never be mistaken for a complete one.
  truncated     BOOLEAN     NOT NULL DEFAULT FALSE,

  -- What the provider reported, and how the oracle scored it. Stored beside the
  -- payload so the decision is reviewable against the evidence.
  outcome       BOOLEAN,
  confidence    NUMERIC(5,4),

  -- When the provider responded. Distinct from received_at (when we persisted
  -- it): the gap between the two is how long evidence sat unwritten, which
  -- matters when reconstructing a dispute timeline.
  responded_at  TIMESTAMPTZ,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT adapter_raw_payloads_size_bounded
    CHECK (response_bytes >= 0 AND response_bytes <= max_raw_payload_bytes())
);

COMMENT ON TABLE adapter_raw_payloads IS
  'Raw provider payloads backing each resolution decision, for audit/dispute review. Audit-class: 7-year retention, manual purge only. See docs/DATA-RETENTION.md.';

-- Primary access path: every payload for one market, in the order fetched.
CREATE INDEX IF NOT EXISTS idx_adapter_raw_payloads_market
  ON adapter_raw_payloads(market_id ASC, received_at ASC);

-- Lets an auditor answer "what did provider X say about this market?" without
-- scanning every market's payloads.
CREATE INDEX IF NOT EXISTS idx_adapter_raw_payloads_provider
  ON adapter_raw_payloads(provider ASC, market_id ASC);

-- Retention registry entry. Audit-class, matching council_votes and
-- oracle_disputes, so a dispute can always be evidenced. Deliberately NOT
-- added to enforce_data_retention(): that function applies operational
-- policies only and must never touch audit evidence.
INSERT INTO data_retention_policies (category, target, class, retention, enforcement, justification) VALUES
  ('adapter_raw_payloads',
   'adapter_raw_payloads',
   'audit',
   INTERVAL '7 years',
   'MANUAL — legal review only; excluded from enforce_data_retention()',
   'Provider responses backing a resolution decision. Primary evidence when a resolution is disputed: without it there is no record of what the provider actually returned. Bounded per-row at 1 MiB.')
ON CONFLICT (category) DO UPDATE SET
  target        = EXCLUDED.target,
  class         = EXCLUDED.class,
  retention     = EXCLUDED.retention,
  enforcement   = EXCLUDED.enforcement,
  justification = EXCLUDED.justification,
  updated_at    = NOW();

COMMIT;
