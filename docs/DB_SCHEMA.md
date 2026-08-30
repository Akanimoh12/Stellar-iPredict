# iPredict — Database Schema Reference

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

> **Scope:** this is the docs-level reference for the shared PostgreSQL schema
> used by [`backend/`](../backend) and [`indexer/`](../indexer). It is accurate
> to the migrations on `implementation-drips` at the time of writing. The
> authoritative source is [`db/migrations/`](../db/migrations) — when this
> document and the SQL disagree, the migrations win. See also
> [`db/README.md`](../db/README.md) for local setup and seeding.

## Overview

The schema has six tables, applied in order by the numbered files in
[`db/migrations/`](../db/migrations):

| Table | Purpose |
| --- | --- |
| `markets` | Indexed copy of on-chain market data |
| `bets` | Per-bettor position for each market |
| `leaderboard` | Denormalized ranking snapshot keyed by wallet address |
| `events` | Raw on-chain event audit log used for replay and backfills |
| `oracle_submissions` | Optimistic-oracle submission and status tracking |
| `council_votes` | Phase 1.5 council member outcome submissions per market |

## Table reference

### `markets`

Canonical market metadata the app reads from the database instead of Soroban
RPC on every request.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGINT` | Primary key; mirrors the on-chain market identifier |
| `question` | `TEXT` | Market question, required |
| `image_url` | `TEXT` | Optional image for the market UI |
| `category` | `VARCHAR(20)` | Market category, used for filtering |
| `end_time` | `BIGINT` | Market resolution deadline, stored as a Unix timestamp |
| `total_yes` | `NUMERIC(30,7)` | Aggregated YES liquidity/volume |
| `total_no` | `NUMERIC(30,7)` | Aggregated NO liquidity/volume |
| `resolved` | `BOOLEAN` | Whether the market has been resolved |
| `outcome` | `BOOLEAN` | Final outcome when resolved; nullable before settlement |
| `cancelled` | `BOOLEAN` | Whether the market was cancelled |
| `creator` | `CHAR(56)` | Wallet address of the market creator |
| `bet_count` | `INTEGER` | Number of recorded bets on the market |
| `created_at` | `TIMESTAMP` | Row creation timestamp |
| `updated_at` | `TIMESTAMP` | Last update timestamp |

Indexes: `idx_markets_category` on `category`, `idx_markets_resolved` on
`(resolved, end_time)`, `idx_markets_active` on
`(resolved, cancelled, end_time)`.

### `bets`

One row per bettor per market — `(market_id, bettor)` is the primary key, so
a user can only hold one position per market.

| Column | Type | Notes |
| --- | --- | --- |
| `market_id` | `BIGINT` | Foreign key to `markets.id` |
| `bettor` | `CHAR(56)` | Wallet address of the bettor |
| `net_amount` | `NUMERIC(30,7)` | Net amount staked by the bettor |
| `gross_amount` | `NUMERIC(30,7)` | Gross amount recorded for the position |
| `is_yes` | `BOOLEAN` | Whether the position is on the YES side |
| `claimed` | `BOOLEAN` | Whether the payout for the position has been claimed |
| `created_at` | `TIMESTAMP` | Row creation timestamp |

Primary key: `(market_id, bettor)`. Index: `idx_bets_bettor` on `bettor`.

### `leaderboard`

A denormalized ranking snapshot served to the frontend, rebuilt from indexed
events by the leaderboard-rebuild job when needed.

| Column | Type | Notes |
| --- | --- | --- |
| `address` | `CHAR(56)` | Primary key; user wallet address |
| `display_name` | `VARCHAR(50)` | Optional display name |
| `points` | `BIGINT` | Current leaderboard points |
| `won_bets` | `INTEGER` | Count of winning positions |
| `lost_bets` | `INTEGER` | Count of losing positions |
| `updated_at` | `TIMESTAMP` | Last leaderboard update |

Index: `idx_lb_points` on `points DESC`.

### `events`

Raw on-chain event records used for auditing, replay, and leaderboard/backfill
jobs.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGSERIAL` | Auto-incrementing primary key |
| `ledger_seq` | `BIGINT` | Ledger sequence for the originating event |
| `tx_hash` | `CHAR(64)` | Transaction hash |
| `event_index` | `BIGINT` | Event position within the transaction, used with `tx_hash` for replay dedupe |
| `event_type` | `VARCHAR(50)` | Event category such as market creation or bet placement |
| `market_id` | `BIGINT` | Optional market identifier |
| `actor` | `CHAR(56)` | Wallet address of the actor |
| `payload` | `JSONB` | Raw event payload |
| `created_at` | `TIMESTAMP` | Row creation timestamp |

Indexes: `idx_events_market` on `market_id`, `idx_events_type` on
`event_type`, `idx_events_ledger` on `ledger_seq DESC`, and a unique index
`idx_events_tx_hash_event_index` on `(tx_hash, event_index)`.

### `oracle_submissions`

Tracks optimistic-oracle submissions through the dispute/finalization
workflow described in
["Optimistic Oracle Contract API"](ORACLE_AND_BACKEND.md#optimistic-oracle-contract-api).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `SERIAL` | Auto-incrementing primary key |
| `market_id` | `INTEGER` | Market identifier |
| `submitter` | `VARCHAR(255)` | Wallet address of the submitter |
| `outcome` | `VARCHAR(255)` | Proposed outcome |
| `bond_amount` | `NUMERIC` | Bond attached to the submission |
| `submitted_at` | `TIMESTAMP WITH TIME ZONE` | Submission timestamp |
| `status` | `oracle_submission_status` | Lifecycle state: `submitted`, `challenged`, `finalized`, or `rejected` |
| `decision` | `VARCHAR(255)` | Finalized decision (`yes`/`no`) |
| `tx_hash` | `CHAR(64)` | Finalization transaction hash |
| `finalized_at` | `TIMESTAMP WITH TIME ZONE` | Finalization timestamp |
| `council_votes` | `JSONB` | Council vote records used to resolve the market |

Indexes: `idx_oracle_submissions_market_id` unique on `market_id`,
`idx_oracle_submissions_status` on `status`.

### `council_votes`

One row per `(market_id, member)` — a Phase 1.5 council member's vote can be
updated but never double-counted. Read by the aggregator's tally
(`oracle/src/aggregator/tally.ts`) to determine when the agreement threshold
is reached.

| Column | Type | Notes |
| --- | --- | --- |
| `market_id` | `BIGINT` | Market identifier |
| `member` | `CHAR(56)` | Council member wallet address |
| `outcome` | `BOOLEAN` | The member's submitted outcome |
| `submitted_at` | `TIMESTAMP WITH TIME ZONE` | Submission timestamp |

Primary key: `(market_id, member)`. Index: `idx_council_votes_market_id` on
`market_id`.

## Entity relationship diagram

```mermaid
erDiagram
    MARKETS ||--o{ BETS : contains
    MARKETS ||--o{ EVENTS : generates
    MARKETS ||--o{ ORACLE_SUBMISSIONS : receives
    MARKETS ||--o{ COUNCIL_VOTES : receives

    MARKETS {
        BIGINT id PK
        TEXT question
        TEXT image_url
        VARCHAR category
        BIGINT end_time
        NUMERIC total_yes
        NUMERIC total_no
        BOOLEAN resolved
        BOOLEAN outcome
        BOOLEAN cancelled
        CHAR creator
        INTEGER bet_count
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    BETS {
        BIGINT market_id PK, FK
        CHAR bettor PK
        NUMERIC net_amount
        NUMERIC gross_amount
        BOOLEAN is_yes
        BOOLEAN claimed
        TIMESTAMP created_at
    }

    LEADERBOARD {
        CHAR address PK
        VARCHAR display_name
        BIGINT points
        INTEGER won_bets
        INTEGER lost_bets
        TIMESTAMP updated_at
    }

    EVENTS {
        BIGSERIAL id PK
        BIGINT ledger_seq
        CHAR tx_hash
        VARCHAR event_type
        BIGINT market_id
        CHAR actor
        JSONB payload
        TIMESTAMP created_at
    }

    ORACLE_SUBMISSIONS {
        SERIAL id PK
        INTEGER market_id
        VARCHAR submitter
        VARCHAR outcome
        NUMERIC bond_amount
        TIMESTAMP submitted_at
        oracle_submission_status status
    }

    COUNCIL_VOTES {
        BIGINT market_id PK
        CHAR member PK
        BOOLEAN outcome
        TIMESTAMP submitted_at
    }
```

`LEADERBOARD` has no foreign key to `MARKETS` — it is a denormalized
per-address snapshot derived from bet and referral events, not a per-market
child table, so it is intentionally excluded from the relationships above.

## Migrations

Each migration is a numbered SQL file applied in filename order:

```
db/migrations/
  0001_create_markets.sql
  0002_markets_indexes.sql
  0003_create_bets.sql
  0004_create_leaderboard.sql
  0005_create_events.sql
  0006_oracle_submissions.sql
  0007_add_event_index_dedupe.sql
  0008_council_votes.sql
  0008_extend_oracle_submissions.down.sql
  0009_oracle_disputes.sql
  0010_dead_letter_events.sql
  0011_extend_oracle_submissions.sql
```

Files ending in `.down.sql` roll back the migration with the matching number.
Apply manually with:

```bash
psql "$DATABASE_URL" -f db/migrations/0001_create_markets.sql
```

or via the runner in [`db/migrate.ts`](../db/migrate.ts). In the production
Docker Compose stack, migrations run automatically on first boot and can be
re-applied against a running database with the `migrate` profile — see
["Migrations" in `BACKEND_DEPLOYMENT.md`](BACKEND_DEPLOYMENT.md#migrations).

## Local seed data

```bash
cd db
npm install
npm run seed
```

Defaults to `postgresql://ipredict:ipredict@localhost:5432/ipredict` if
`DATABASE_URL` is unset. The seed is idempotent — tables use
`CREATE TABLE IF NOT EXISTS` and rows use `ON CONFLICT ... DO UPDATE` — so it
is safe to run more than once.
