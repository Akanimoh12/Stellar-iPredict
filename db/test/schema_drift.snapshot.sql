--
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: schema_drift_check; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA schema_drift_check;


--
-- Name: oracle_dispute_status; Type: TYPE; Schema: schema_drift_check; Owner: -
--

CREATE TYPE schema_drift_check.oracle_dispute_status AS ENUM (
 'challenged',
 'escalated'
);


--
-- Name: oracle_submission_status; Type: TYPE; Schema: schema_drift_check; Owner: -
--

CREATE TYPE schema_drift_check.oracle_submission_status AS ENUM (
 'submitted',
 'challenged',
 'finalized',
 'rejected'
);


--
-- Name: archive_old_events(integer, integer); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.archive_old_events(retention_days integer DEFAULT 30, batch_size integer DEFAULT 10000) RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE
 moved_count INTEGER := 0;
BEGIN
 WITH rows_to_archive AS (
 SELECT id, ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload, created_at
 FROM events
 WHERE created_at < NOW() - (retention_days || ' days')::interval
 ORDER BY created_at ASC
 LIMIT batch_size
 ),
 archived AS (
 INSERT INTO events_archive (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload, created_at)
 SELECT ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload, created_at
 FROM rows_to_archive
 ON CONFLICT (tx_hash, event_index) DO NOTHING
 ),
 deleted AS (
 DELETE FROM events
 WHERE id IN (SELECT id FROM rows_to_archive)
 RETURNING id
 )
 SELECT count(*) INTO moved_count FROM deleted;

 RETURN moved_count;
END;
$$;


--
-- Name: FUNCTION archive_old_events(retention_days integer, batch_size integer); Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON FUNCTION schema_drift_check.archive_old_events(retention_days integer, batch_size integer) IS 'Moves stale event rows from events to events_archive in bounded batches without holding long-lived write locks.';


--
-- Name: enforce_data_retention(); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.enforce_data_retention() RETURNS TABLE(category text, rows_removed integer)
 LANGUAGE plpgsql
 AS $$
BEGIN
 category := 'events_hot'; rows_removed := archive_old_events(30, 10000); RETURN NEXT;
 category := 'events_archive'; rows_removed := purge_events_archive(400, 10000); RETURN NEXT;
 category := 'dead_letter_events'; rows_removed := purge_dead_letter_events(90, 5000); RETURN NEXT;
 category := 'idempotency_keys'; rows_removed := purge_idempotency_keys(24, 5000); RETURN NEXT;
 category := 'oracle_submissions_rejected'; rows_removed := purge_stale_oracle_submissions(180, 2000); RETURN NEXT;
 category := 'oracle_resolution_lag'; rows_removed := purge_oracle_resolution_lag(400, 10000); RETURN NEXT;
END;
$$;


--
-- Name: FUNCTION enforce_data_retention(); Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON FUNCTION schema_drift_check.enforce_data_retention() IS 'Issue #646: applies all operational retention policies in bounded batches. Audit-class data (finalized oracle_submissions, council_votes, oracle_disputes) is deliberately excluded.';


--
-- Name: enforce_oracle_submission_transition(); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.enforce_oracle_submission_transition() RETURNS trigger
 LANGUAGE plpgsql
 AS $$
BEGIN
 IF NEW.status <> OLD.status AND NOT (
 (OLD.status = 'submitted' AND NEW.status IN ('challenged', 'finalized', 'rejected')) OR
 (OLD.status = 'challenged' AND NEW.status IN ('finalized', 'rejected'))
 ) THEN
 RAISE EXCEPTION 'illegal oracle_submission status transition: % -> %', OLD.status, NEW.status;
 END IF;
 RETURN NEW;
END;
$$;


--
-- Name: max_raw_payload_bytes(); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.max_raw_payload_bytes() RETURNS integer
 LANGUAGE sql IMMUTABLE
 AS $$ SELECT 1048576; $$;


--
-- Name: purge_dead_letter_events(integer, integer); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.purge_dead_letter_events(retention_days integer DEFAULT 90, batch_size integer DEFAULT 5000) RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE removed INTEGER := 0;
BEGIN
 WITH doomed AS (
 SELECT id FROM dead_letter_events
 WHERE created_at < NOW() - (retention_days || ' days')::interval
 ORDER BY created_at ASC
 LIMIT batch_size
 )
 DELETE FROM dead_letter_events WHERE id IN (SELECT id FROM doomed);
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END;
$$;


--
-- Name: purge_events_archive(integer, integer); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.purge_events_archive(retention_days integer DEFAULT 400, batch_size integer DEFAULT 10000) RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE removed INTEGER := 0;
BEGIN
 WITH doomed AS (
 SELECT id FROM events_archive
 WHERE created_at < NOW() - (retention_days || ' days')::interval
 ORDER BY created_at ASC
 LIMIT batch_size
 )
 DELETE FROM events_archive WHERE id IN (SELECT id FROM doomed);
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END;
$$;


--
-- Name: purge_idempotency_keys(integer, integer); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.purge_idempotency_keys(retention_hours integer DEFAULT 24, batch_size integer DEFAULT 5000) RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE removed INTEGER := 0;
BEGIN
 WITH doomed AS (
 SELECT idempotency_key FROM idempotency_keys
 WHERE created_at < NOW() - (retention_hours || ' hours')::interval
 ORDER BY created_at ASC
 LIMIT batch_size
 )
 DELETE FROM idempotency_keys WHERE idempotency_key IN (SELECT idempotency_key FROM doomed);
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END;
$$;


--
-- Name: purge_oracle_resolution_lag(integer, integer); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.purge_oracle_resolution_lag(retention_days integer DEFAULT 400, batch_size integer DEFAULT 10000) RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE removed INTEGER := 0;
BEGIN
 WITH doomed AS (
 SELECT market_id
 FROM oracle_resolution_lag
 WHERE created_at < NOW() - (retention_days || ' days')::interval
 ORDER BY created_at ASC
 LIMIT batch_size
 )
 DELETE FROM oracle_resolution_lag WHERE market_id IN (SELECT market_id FROM doomed);
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END;
$$;


--
-- Name: purge_stale_oracle_submissions(integer, integer); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.purge_stale_oracle_submissions(retention_days integer DEFAULT 180, batch_size integer DEFAULT 2000) RETURNS integer
 LANGUAGE plpgsql
 AS $$
DECLARE removed INTEGER := 0;
BEGIN
 WITH doomed AS (
 SELECT s.id
 FROM oracle_submissions s
 LEFT JOIN oracle_disputes d ON d.market_id = s.market_id
 WHERE s.status = 'rejected'
 AND d.id IS NULL
 AND COALESCE(s.finalized_at, s.submitted_at) < NOW() - (retention_days || ' days')::interval
 ORDER BY s.id ASC
 LIMIT batch_size
 )
 DELETE FROM oracle_submissions WHERE id IN (SELECT id FROM doomed);
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: schema_drift_check; Owner: -
--

CREATE FUNCTION schema_drift_check.set_updated_at() RETURNS trigger
 LANGUAGE plpgsql
 AS $$
BEGIN
 NEW.updated_at = now();
 RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: adapter_raw_payloads; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.adapter_raw_payloads (
 id bigint NOT NULL,
 market_id text NOT NULL,
 provider text NOT NULL,
 raw_request jsonb,
 raw_response jsonb NOT NULL,
 response_bytes integer NOT NULL,
 truncated boolean DEFAULT false NOT NULL,
 outcome boolean,
 confidence numeric(5,4),
 responded_at timestamp with time zone,
 received_at timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT adapter_raw_payloads_size_bounded CHECK (((response_bytes >= 0) AND (response_bytes <= schema_drift_check.max_raw_payload_bytes())))
);


--
-- Name: TABLE adapter_raw_payloads; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.adapter_raw_payloads IS 'Raw provider payloads backing each resolution decision, for audit/dispute review. Audit-class: 7-year retention, manual purge only. See docs/DATA-RETENTION.md.';


--
-- Name: adapter_raw_payloads_id_seq; Type: SEQUENCE; Schema: schema_drift_check; Owner: -
--

CREATE SEQUENCE schema_drift_check.adapter_raw_payloads_id_seq
 START WITH 1
 INCREMENT BY 1
 NO MINVALUE
 NO MAXVALUE
 CACHE 1;


--
-- Name: adapter_raw_payloads_id_seq; Type: SEQUENCE OWNED BY; Schema: schema_drift_check; Owner: -
--

ALTER SEQUENCE schema_drift_check.adapter_raw_payloads_id_seq OWNED BY schema_drift_check.adapter_raw_payloads.id;


--
-- Name: bets; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.bets (
 market_id bigint NOT NULL,
 bettor character(56) NOT NULL,
 net_amount numeric(30,7) NOT NULL,
 gross_amount numeric(30,7) NOT NULL,
 is_yes boolean NOT NULL,
 claimed boolean DEFAULT false NOT NULL,
 created_at timestamp without time zone DEFAULT now()
);


--
-- Name: council_votes; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.council_votes (
 market_id bigint NOT NULL,
 member character(56) NOT NULL,
 outcome boolean NOT NULL,
 submitted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE council_votes; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.council_votes IS 'Authoritative current council vote per market and member. Writes use an upsert on the primary key; readers tally these rows rather than process-local vote state.';


--
-- Name: data_retention_policies; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.data_retention_policies (
 category text NOT NULL,
 target text NOT NULL,
 class text NOT NULL,
 retention interval NOT NULL,
 enforcement text NOT NULL,
 justification text NOT NULL,
 updated_at timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT data_retention_policies_class_check CHECK ((class = ANY (ARRAY['operational'::text, 'audit'::text])))
);


--
-- Name: TABLE data_retention_policies; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.data_retention_policies IS 'Issue #646: retention period + justification for every data category. See docs/DATA-RETENTION.md.';


--
-- Name: dead_letter_events; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.dead_letter_events (
 id bigint NOT NULL,
 ledger_seq bigint NOT NULL,
 tx_hash character(64) NOT NULL,
 raw_event jsonb NOT NULL,
 error_message text NOT NULL,
 created_at timestamp with time zone DEFAULT now() NOT NULL,
 attempt_count integer DEFAULT 0 NOT NULL,
 last_error text,
 resolved_at timestamp with time zone
);


--
-- Name: dead_letter_events_id_seq; Type: SEQUENCE; Schema: schema_drift_check; Owner: -
--

CREATE SEQUENCE schema_drift_check.dead_letter_events_id_seq
 START WITH 1
 INCREMENT BY 1
 NO MINVALUE
 NO MAXVALUE
 CACHE 1;


--
-- Name: dead_letter_events_id_seq; Type: SEQUENCE OWNED BY; Schema: schema_drift_check; Owner: -
--

ALTER SEQUENCE schema_drift_check.dead_letter_events_id_seq OWNED BY schema_drift_check.dead_letter_events.id;


--
-- Name: events; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.events (
 id bigint NOT NULL,
 ledger_seq bigint NOT NULL,
 tx_hash character(64) NOT NULL,
 event_type character varying(50) NOT NULL,
 market_id bigint,
 actor character(56),
 payload jsonb,
 created_at timestamp without time zone DEFAULT now(),
 event_index bigint NOT NULL
);


--
-- Name: events_archive; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.events_archive (
 id bigint NOT NULL,
 ledger_seq bigint NOT NULL,
 tx_hash character(64) NOT NULL,
 event_index bigint NOT NULL,
 event_type character varying(50) NOT NULL,
 market_id bigint,
 actor character(56),
 payload jsonb,
 created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE events_archive; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.events_archive IS 'Archive of older on-chain events retained for forensic replay and recovery, while keeping the hot events table within the replay retention window.';


--
-- Name: events_archive_id_seq; Type: SEQUENCE; Schema: schema_drift_check; Owner: -
--

CREATE SEQUENCE schema_drift_check.events_archive_id_seq
 START WITH 1
 INCREMENT BY 1
 NO MINVALUE
 NO MAXVALUE
 CACHE 1;


--
-- Name: events_archive_id_seq; Type: SEQUENCE OWNED BY; Schema: schema_drift_check; Owner: -
--

ALTER SEQUENCE schema_drift_check.events_archive_id_seq OWNED BY schema_drift_check.events_archive.id;


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: schema_drift_check; Owner: -
--

CREATE SEQUENCE schema_drift_check.events_id_seq
 START WITH 1
 INCREMENT BY 1
 NO MINVALUE
 NO MAXVALUE
 CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: schema_drift_check; Owner: -
--

ALTER SEQUENCE schema_drift_check.events_id_seq OWNED BY schema_drift_check.events.id;


--
-- Name: idempotency_keys; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.idempotency_keys (
 idempotency_key character varying(128) NOT NULL,
 payload_hash character varying(64) NOT NULL,
 response_body jsonb NOT NULL,
 status_code integer NOT NULL,
 created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE idempotency_keys; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.idempotency_keys IS 'Stores idempotent oracle submission responses for safe retries within a bounded retention window.';


--
-- Name: leaderboard; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.leaderboard (
 address character(56) NOT NULL,
 display_name character varying(50),
 points bigint DEFAULT 0 NOT NULL,
 won_bets integer DEFAULT 0 NOT NULL,
 lost_bets integer DEFAULT 0 NOT NULL,
 updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: leaderboard_rebuild_checkpoint; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.leaderboard_rebuild_checkpoint (
 id integer NOT NULL,
 last_processed_ledger bigint NOT NULL,
 event_count bigint DEFAULT 0 NOT NULL,
 updated_at timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT leaderboard_rebuild_checkpoint_id_check CHECK ((id = 1))
);


--
-- Name: TABLE leaderboard_rebuild_checkpoint; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.leaderboard_rebuild_checkpoint IS 'Tracks progress of leaderboard rebuild jobs for resumability after failures';


--
-- Name: COLUMN leaderboard_rebuild_checkpoint.id; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON COLUMN schema_drift_check.leaderboard_rebuild_checkpoint.id IS 'Singleton row ID (always 1)';


--
-- Name: COLUMN leaderboard_rebuild_checkpoint.last_processed_ledger; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON COLUMN schema_drift_check.leaderboard_rebuild_checkpoint.last_processed_ledger IS 'Last ledger successfully processed during rebuild';


--
-- Name: COLUMN leaderboard_rebuild_checkpoint.event_count; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON COLUMN schema_drift_check.leaderboard_rebuild_checkpoint.event_count IS 'Number of events processed so far';


--
-- Name: COLUMN leaderboard_rebuild_checkpoint.updated_at; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON COLUMN schema_drift_check.leaderboard_rebuild_checkpoint.updated_at IS 'Last checkpoint update timestamp';


--
-- Name: markets; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.markets (
 id bigint NOT NULL,
 question text NOT NULL,
 image_url text,
 category character varying(20) NOT NULL,
 end_time bigint NOT NULL,
 total_yes numeric(30,7) DEFAULT 0 NOT NULL,
 total_no numeric(30,7) DEFAULT 0 NOT NULL,
 resolved boolean DEFAULT false NOT NULL,
 outcome boolean,
 cancelled boolean DEFAULT false NOT NULL,
 creator character(56) NOT NULL,
 bet_count integer DEFAULT 0 NOT NULL,
 created_at timestamp without time zone DEFAULT now(),
 updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: oracle_ambiguous_tallies; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.oracle_ambiguous_tallies (
 market_id bigint NOT NULL,
 yes_votes integer NOT NULL,
 no_votes integer NOT NULL,
 threshold integer NOT NULL,
 status text DEFAULT 'manual_review'::text NOT NULL,
 first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
 last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
 alert_claimed_at timestamp with time zone,
 CONSTRAINT oracle_ambiguous_tallies_status_check CHECK ((status = ANY (ARRAY['manual_review'::text, 'cleared'::text])))
);


--
-- Name: TABLE oracle_ambiguous_tallies; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.oracle_ambiguous_tallies IS 'Issue #453: markets whose council tally reached both outcomes; held for manual review until cleared.';


--
-- Name: oracle_disputes; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.oracle_disputes (
 id integer NOT NULL,
 market_id bigint NOT NULL,
 submitter character(56) NOT NULL,
 challenger character(56) NOT NULL,
 outcome character varying(255) NOT NULL,
 submitter_bond numeric NOT NULL,
 challenger_bond numeric NOT NULL,
 status schema_drift_check.oracle_dispute_status DEFAULT 'challenged'::schema_drift_check.oracle_dispute_status NOT NULL,
 challenged_at timestamp with time zone,
 escalated_at timestamp with time zone,
 council_deadline timestamp with time zone,
 created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
 total_bond numeric GENERATED ALWAYS AS ((submitter_bond + challenger_bond)) STORED,
 updated_at timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT ck_oracle_disputes_challenger_address CHECK ((challenger ~ '^G[A-Z2-7]{55}$'::text)),
 CONSTRAINT ck_oracle_disputes_challenger_bond_gt_submitter CHECK ((challenger_bond > submitter_bond)),
 CONSTRAINT ck_oracle_disputes_challenger_bond_positive CHECK ((challenger_bond > (0)::numeric)),
 CONSTRAINT ck_oracle_disputes_outcome_canonical CHECK (((outcome)::text = ANY ((ARRAY['YES'::character varying, 'NO'::character varying])::text[]))),
 CONSTRAINT ck_oracle_disputes_submitter_address CHECK ((submitter ~ '^G[A-Z2-7]{55}$'::text)),
 CONSTRAINT ck_oracle_disputes_submitter_bond_positive CHECK ((submitter_bond > (0)::numeric))
);


--
-- Name: COLUMN oracle_disputes.outcome; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON COLUMN schema_drift_check.oracle_disputes.outcome IS 'Disputed/proposed canonical binary outcome: ''YES'' or ''NO''. Enforced by ck_oracle_disputes_outcome_canonical (#408).';


--
-- Name: oracle_disputes_id_seq; Type: SEQUENCE; Schema: schema_drift_check; Owner: -
--

CREATE SEQUENCE schema_drift_check.oracle_disputes_id_seq
 AS integer
 START WITH 1
 INCREMENT BY 1
 NO MINVALUE
 NO MAXVALUE
 CACHE 1;


--
-- Name: oracle_disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: schema_drift_check; Owner: -
--

ALTER SEQUENCE schema_drift_check.oracle_disputes_id_seq OWNED BY schema_drift_check.oracle_disputes.id;


--
-- Name: oracle_providers; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.oracle_providers (
 address character varying(64) NOT NULL,
 registered_at timestamp with time zone DEFAULT now() NOT NULL,
 active boolean DEFAULT true NOT NULL
);


--
-- Name: TABLE oracle_providers; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.oracle_providers IS 'Registered oracle providers authorized to submit outcomes. Providers must be active to submit.';


--
-- Name: oracle_resolution_lag; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.oracle_resolution_lag (
 market_id bigint NOT NULL,
 end_time bigint NOT NULL,
 resolved_at_epoch bigint NOT NULL,
 lag_hours double precision NOT NULL,
 created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE oracle_resolution_lag; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON TABLE schema_drift_check.oracle_resolution_lag IS 'Issue #451: durable resolution-lag observations written after finalization commits; retained for 400 days.';


--
-- Name: oracle_submissions; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.oracle_submissions (
 id integer NOT NULL,
 market_id bigint NOT NULL,
 submitter character(56) NOT NULL,
 outcome character varying(255) NOT NULL,
 bond_amount numeric NOT NULL,
 submitted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
 status schema_drift_check.oracle_submission_status DEFAULT 'submitted'::schema_drift_check.oracle_submission_status NOT NULL,
 decision character varying(255),
 tx_hash character(64),
 finalized_at timestamp with time zone,
 council_votes jsonb DEFAULT '{}'::jsonb,
 nonce character varying(64),
 request_timestamp timestamp with time zone,
 updated_at timestamp with time zone DEFAULT now() NOT NULL,
 request_id text,
 CONSTRAINT chk_oracle_submissions_request_id CHECK (((request_id IS NULL) OR (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'::text))),
 CONSTRAINT ck_oracle_submissions_outcome_canonical CHECK (((outcome)::text = ANY ((ARRAY['YES'::character varying, 'NO'::character varying])::text[]))),
 CONSTRAINT ck_oracle_submissions_submitter_address CHECK ((submitter ~ '^G[A-Z2-7]{55}$'::text))
);


--
-- Name: COLUMN oracle_submissions.outcome; Type: COMMENT; Schema: schema_drift_check; Owner: -
--

COMMENT ON COLUMN schema_drift_check.oracle_submissions.outcome IS 'Canonical binary outcome: ''YES'' or ''NO''. Enforced by ck_oracle_submissions_outcome_canonical (#650).';


--
-- Name: oracle_submissions_id_seq; Type: SEQUENCE; Schema: schema_drift_check; Owner: -
--

CREATE SEQUENCE schema_drift_check.oracle_submissions_id_seq
 AS integer
 START WITH 1
 INCREMENT BY 1
 NO MINVALUE
 NO MAXVALUE
 CACHE 1;


--
-- Name: oracle_submissions_id_seq; Type: SEQUENCE OWNED BY; Schema: schema_drift_check; Owner: -
--

ALTER SEQUENCE schema_drift_check.oracle_submissions_id_seq OWNED BY schema_drift_check.oracle_submissions.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.schema_migrations (
 filename text NOT NULL,
 applied_at timestamp with time zone DEFAULT now() NOT NULL,
 checksum text
);


--
-- Name: token_balances; Type: TABLE; Schema: schema_drift_check; Owner: -
--

CREATE TABLE schema_drift_check.token_balances (
 address character(56) NOT NULL,
 balance numeric(30,7) DEFAULT 0 NOT NULL,
 updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: adapter_raw_payloads id; Type: DEFAULT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.adapter_raw_payloads ALTER COLUMN id SET DEFAULT nextval('schema_drift_check.adapter_raw_payloads_id_seq'::regclass);


--
-- Name: dead_letter_events id; Type: DEFAULT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.dead_letter_events ALTER COLUMN id SET DEFAULT nextval('schema_drift_check.dead_letter_events_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.events ALTER COLUMN id SET DEFAULT nextval('schema_drift_check.events_id_seq'::regclass);


--
-- Name: events_archive id; Type: DEFAULT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.events_archive ALTER COLUMN id SET DEFAULT nextval('schema_drift_check.events_archive_id_seq'::regclass);


--
-- Name: oracle_disputes id; Type: DEFAULT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_disputes ALTER COLUMN id SET DEFAULT nextval('schema_drift_check.oracle_disputes_id_seq'::regclass);


--
-- Name: oracle_submissions id; Type: DEFAULT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_submissions ALTER COLUMN id SET DEFAULT nextval('schema_drift_check.oracle_submissions_id_seq'::regclass);


--
-- Name: adapter_raw_payloads adapter_raw_payloads_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.adapter_raw_payloads
 ADD CONSTRAINT adapter_raw_payloads_pkey PRIMARY KEY (id);


--
-- Name: bets bets_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.bets
 ADD CONSTRAINT bets_pkey PRIMARY KEY (market_id, bettor);


--
-- Name: council_votes council_votes_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.council_votes
 ADD CONSTRAINT council_votes_pkey PRIMARY KEY (market_id, member);


--
-- Name: data_retention_policies data_retention_policies_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.data_retention_policies
 ADD CONSTRAINT data_retention_policies_pkey PRIMARY KEY (category);


--
-- Name: dead_letter_events dead_letter_events_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.dead_letter_events
 ADD CONSTRAINT dead_letter_events_pkey PRIMARY KEY (id);


--
-- Name: events_archive events_archive_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.events_archive
 ADD CONSTRAINT events_archive_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.events
 ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.idempotency_keys
 ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (idempotency_key);


--
-- Name: leaderboard leaderboard_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.leaderboard
 ADD CONSTRAINT leaderboard_pkey PRIMARY KEY (address);


--
-- Name: leaderboard_rebuild_checkpoint leaderboard_rebuild_checkpoint_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.leaderboard_rebuild_checkpoint
 ADD CONSTRAINT leaderboard_rebuild_checkpoint_pkey PRIMARY KEY (id);


--
-- Name: markets markets_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.markets
 ADD CONSTRAINT markets_pkey PRIMARY KEY (id);


--
-- Name: oracle_ambiguous_tallies oracle_ambiguous_tallies_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_ambiguous_tallies
 ADD CONSTRAINT oracle_ambiguous_tallies_pkey PRIMARY KEY (market_id);


--
-- Name: oracle_disputes oracle_disputes_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_disputes
 ADD CONSTRAINT oracle_disputes_pkey PRIMARY KEY (id);


--
-- Name: oracle_providers oracle_providers_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_providers
 ADD CONSTRAINT oracle_providers_pkey PRIMARY KEY (address);


--
-- Name: oracle_resolution_lag oracle_resolution_lag_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_resolution_lag
 ADD CONSTRAINT oracle_resolution_lag_pkey PRIMARY KEY (market_id);


--
-- Name: oracle_submissions oracle_submissions_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_submissions
 ADD CONSTRAINT oracle_submissions_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.schema_migrations
 ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: token_balances token_balances_pkey; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.token_balances
 ADD CONSTRAINT token_balances_pkey PRIMARY KEY (address);


--
-- Name: oracle_disputes uq_oracle_disputes_market_id; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_disputes
 ADD CONSTRAINT uq_oracle_disputes_market_id UNIQUE (market_id);


--
-- Name: oracle_submissions uq_oracle_submissions_market_id; Type: CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_submissions
 ADD CONSTRAINT uq_oracle_submissions_market_id UNIQUE (market_id);


--
-- Name: idx_adapter_raw_payloads_market; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_adapter_raw_payloads_market ON schema_drift_check.adapter_raw_payloads USING btree (market_id, received_at);


--
-- Name: idx_adapter_raw_payloads_provider; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_adapter_raw_payloads_provider ON schema_drift_check.adapter_raw_payloads USING btree (provider, market_id);


--
-- Name: idx_bets_bettor; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_bets_bettor ON schema_drift_check.bets USING btree (bettor);


--
-- Name: idx_council_votes_market_id; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_council_votes_market_id ON schema_drift_check.council_votes USING btree (market_id);


--
-- Name: idx_dead_letter_events_created_at; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_dead_letter_events_created_at ON schema_drift_check.dead_letter_events USING btree (created_at);


--
-- Name: idx_dead_letter_events_ledger; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_dead_letter_events_ledger ON schema_drift_check.dead_letter_events USING btree (ledger_seq DESC);


--
-- Name: idx_dead_letter_events_unresolved; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_dead_letter_events_unresolved ON schema_drift_check.dead_letter_events USING btree (created_at) WHERE (resolved_at IS NULL);


--
-- Name: idx_events_archive_created_at; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_events_archive_created_at ON schema_drift_check.events_archive USING btree (created_at DESC);


--
-- Name: idx_events_archive_tx_hash_event_index; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE UNIQUE INDEX idx_events_archive_tx_hash_event_index ON schema_drift_check.events_archive USING btree (tx_hash, event_index);


--
-- Name: idx_events_event_type; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_events_event_type ON schema_drift_check.events USING btree (event_type);


--
-- Name: idx_events_ledger_seq; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_events_ledger_seq ON schema_drift_check.events USING btree (ledger_seq DESC);


--
-- Name: idx_events_market_id; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_events_market_id ON schema_drift_check.events USING btree (market_id);


--
-- Name: idx_events_tx_hash_event_index; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE UNIQUE INDEX idx_events_tx_hash_event_index ON schema_drift_check.events USING btree (tx_hash, event_index);


--
-- Name: idx_idempotency_keys_created_at; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_idempotency_keys_created_at ON schema_drift_check.idempotency_keys USING btree (created_at);


--
-- Name: idx_lb_points; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_lb_points ON schema_drift_check.leaderboard USING btree (points DESC);


--
-- Name: idx_markets_active; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_markets_active ON schema_drift_check.markets USING btree (resolved, cancelled, end_time);


--
-- Name: idx_markets_active_partial; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_markets_active_partial ON schema_drift_check.markets USING btree (end_time) WHERE ((resolved = false) AND (cancelled = false));


--
-- Name: idx_markets_category; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_markets_category ON schema_drift_check.markets USING btree (category);


--
-- Name: idx_markets_resolved; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_markets_resolved ON schema_drift_check.markets USING btree (resolved, end_time);


--
-- Name: idx_markets_volume; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_markets_volume ON schema_drift_check.markets USING btree (((total_yes + total_no)) DESC);


--
-- Name: idx_oracle_disputes_status; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_oracle_disputes_status ON schema_drift_check.oracle_disputes USING btree (status);


--
-- Name: idx_oracle_submissions_market_id; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_oracle_submissions_market_id ON schema_drift_check.oracle_submissions USING btree (market_id);


--
-- Name: idx_oracle_submissions_nonce; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_oracle_submissions_nonce ON schema_drift_check.oracle_submissions USING btree (nonce) WHERE (nonce IS NOT NULL);


--
-- Name: idx_oracle_submissions_request_id; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_oracle_submissions_request_id ON schema_drift_check.oracle_submissions USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: idx_oracle_submissions_request_timestamp; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_oracle_submissions_request_timestamp ON schema_drift_check.oracle_submissions USING btree (request_timestamp) WHERE (request_timestamp IS NOT NULL);


--
-- Name: idx_oracle_submissions_status; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_oracle_submissions_status ON schema_drift_check.oracle_submissions USING btree (status);


--
-- Name: idx_token_balances_balance; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_token_balances_balance ON schema_drift_check.token_balances USING btree (balance DESC);


--
-- Name: idx_token_balances_updated_at; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX idx_token_balances_updated_at ON schema_drift_check.token_balances USING btree (updated_at DESC);


--
-- Name: oracle_ambiguous_tallies_pending_idx; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX oracle_ambiguous_tallies_pending_idx ON schema_drift_check.oracle_ambiguous_tallies USING btree (market_id) WHERE (status = 'manual_review'::text);


--
-- Name: oracle_resolution_lag_resolved_at_idx; Type: INDEX; Schema: schema_drift_check; Owner: -
--

CREATE INDEX oracle_resolution_lag_resolved_at_idx ON schema_drift_check.oracle_resolution_lag USING btree (resolved_at_epoch DESC);


--
-- Name: oracle_disputes trg_oracle_disputes_updated_at; Type: TRIGGER; Schema: schema_drift_check; Owner: -
--

CREATE TRIGGER trg_oracle_disputes_updated_at BEFORE UPDATE ON schema_drift_check.oracle_disputes FOR EACH ROW EXECUTE FUNCTION schema_drift_check.set_updated_at();


--
-- Name: oracle_submissions trg_oracle_submission_status_transition; Type: TRIGGER; Schema: schema_drift_check; Owner: -
--

CREATE TRIGGER trg_oracle_submission_status_transition BEFORE UPDATE OF status ON schema_drift_check.oracle_submissions FOR EACH ROW EXECUTE FUNCTION schema_drift_check.enforce_oracle_submission_transition();


--
-- Name: oracle_submissions trg_oracle_submissions_updated_at; Type: TRIGGER; Schema: schema_drift_check; Owner: -
--

CREATE TRIGGER trg_oracle_submissions_updated_at BEFORE UPDATE ON schema_drift_check.oracle_submissions FOR EACH ROW EXECUTE FUNCTION schema_drift_check.set_updated_at();


--
-- Name: bets bets_market_id_fkey; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.bets
 ADD CONSTRAINT bets_market_id_fkey FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id);


--
-- Name: events_archive events_archive_market_id_fkey; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.events_archive
 ADD CONSTRAINT events_archive_market_id_fkey FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id);


--
-- Name: events events_market_id_fkey; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.events
 ADD CONSTRAINT events_market_id_fkey FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id);


--
-- Name: council_votes fk_council_votes_market_id; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.council_votes
 ADD CONSTRAINT fk_council_votes_market_id FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id) ON DELETE RESTRICT;


--
-- Name: oracle_disputes fk_oracle_disputes_market_id; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_disputes
 ADD CONSTRAINT fk_oracle_disputes_market_id FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id) ON DELETE RESTRICT;


--
-- Name: oracle_submissions fk_oracle_submissions_market_id; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_submissions
 ADD CONSTRAINT fk_oracle_submissions_market_id FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id) ON DELETE RESTRICT;


--
-- Name: oracle_ambiguous_tallies oracle_ambiguous_tallies_market_id_fkey; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_ambiguous_tallies
 ADD CONSTRAINT oracle_ambiguous_tallies_market_id_fkey FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id) ON DELETE RESTRICT;


--
-- Name: oracle_resolution_lag oracle_resolution_lag_market_id_fkey; Type: FK CONSTRAINT; Schema: schema_drift_check; Owner: -
--

ALTER TABLE ONLY schema_drift_check.oracle_resolution_lag
 ADD CONSTRAINT oracle_resolution_lag_market_id_fkey FOREIGN KEY (market_id) REFERENCES schema_drift_check.markets(id) ON DELETE RESTRICT;


--
--
