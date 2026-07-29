# iPredict Database

Shared PostgreSQL schema for the [`backend/`](../backend) and [`indexer/`](../indexer).
SQL migrations live in [`migrations/`](./migrations), applied in filename order.

> **Branch:** all work happens on `implementation-drips`.

## Schema overview

This document is the contributor-facing reference for the core database tables used by the backend and indexer. The current schema covers six tables:

- `markets` — indexed copy of on-chain market data
- `bets` — per-bettor positions per market
- `leaderboard` — denormalized ranking snapshot keyed by wallet address
- `events` — raw on-chain event audit log used for replay and backfills
- `oracle_submissions` — oracle workflow submissions and status tracking
- `council_votes` — Phase 1.5 council member outcome submissions per market

## Table reference

### `markets`

Stores the canonical market metadata that the app reads from the database.

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

Indexes:
- `idx_markets_category` on `category`
- `idx_markets_resolved` on `(resolved, end_time)`
- `idx_markets_active` on `(resolved, cancelled, end_time)`

### `bets`

Stores each bettor’s position for a market. The table is keyed by `(market_id, bettor)` so a user can only have one row per market.

| Column | Type | Notes |
| --- | --- | --- |
| `market_id` | `BIGINT` | Foreign key to `markets.id` |
| `bettor` | `CHAR(56)` | Wallet address of the bettor |
| `net_amount` | `NUMERIC(30,7)` | Net amount staked by the bettor |
| `gross_amount` | `NUMERIC(30,7)` | Gross amount recorded for the position |
| `is_yes` | `BOOLEAN` | Whether the position is on the YES side |
| `claimed` | `BOOLEAN` | Whether the payout for the position has been claimed |
| `created_at` | `TIMESTAMP` | Row creation timestamp |

Primary key:
- `(market_id, bettor)`

Index:
- `idx_bets_bettor` on `bettor`

### `leaderboard`

A denormalized ranking snapshot used by the frontend and APIs. It is rebuilt from indexed events when needed.

| Column | Type | Notes |
| --- | --- | --- |
| `address` | `CHAR(56)` | Primary key; user wallet address |
| `display_name` | `VARCHAR(50)` | Optional display name |
| `points` | `BIGINT` | Current leaderboard points |
| `won_bets` | `INTEGER` | Count of winning positions |
| `lost_bets` | `INTEGER` | Count of losing positions |
| `updated_at` | `TIMESTAMP` | Last leaderboard update |

Index:
- `idx_lb_points` on `points DESC`

### `events`

Stores raw on-chain event records for auditing, replay, and leaderboard rebuild jobs.

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

Indexes:
- `idx_events_market` on `market_id`
- `idx_events_type` on `event_type`
- `idx_events_ledger` on `ledger_seq DESC`
- `idx_events_tx_hash_event_index` unique on `(tx_hash, event_index)`

### `oracle_submissions`

Tracks oracle submissions for dispute and resolution workflows.

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

Indexes:
- `idx_oracle_submissions_market_id` unique on `market_id`
- `idx_oracle_submissions_status` on `status`

### `council_votes`

Tracks each Phase 1.5 council member's submitted outcome per market. One row
per `(market_id, member)` — a member's vote can be updated but never
double-counted. Read by the aggregator's tally to determine when threshold
is reached.

| Column | Type | Notes |
| --- | --- | --- |
| `market_id` | `BIGINT` | Market identifier |
| `member` | `CHAR(56)` | Council member wallet address |
| `outcome` | `BOOLEAN` | The member's submitted outcome |
| `submitted_at` | `TIMESTAMP WITH TIME ZONE` | Submission timestamp |

Primary key:
- `(market_id, member)`

Index:
- `idx_council_votes_market_id` on `market_id`

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

## Migrations

Each migration is a numbered SQL file:

```
migrations/
  0001_create_markets.sql
  0006_oracle_submissions.sql
  0008_council_votes.sql
```

Apply with the migration runner (tracked as its own issue) or manually:

```bash
psql "$DATABASE_URL" -f db/migrations/0001_create_markets.sql
```

## Local Seed Data

Use the seed script to populate realistic local development records for
`markets`, `bets`, and `leaderboard` without running the full indexer.

```bash
cd db
npm install
npm run seed
```

Defaults to `postgresql://ipredict:ipredict@localhost:5432/ipredict` if
`DATABASE_URL` is not set.

The seed is idempotent:
- Tables are created with `CREATE TABLE IF NOT EXISTS`
- Records are inserted with `ON CONFLICT ... DO UPDATE`
- Safe to run multiple times

## Contributing

Pick an open issue labelled `area:db`, branch off `implementation-drips`,
PR back to `implementation-drips`.
