# iPredict Database

Shared PostgreSQL schema for the [`backend/`](../backend) and [`indexer/`](../indexer).
SQL migrations live in [`migrations/`](./migrations), applied in filename order.

> **Branch:** all work happens on `implementation-drips`.

## Schema overview

See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#database-schema)
for the full reference. Core tables:

- `markets` — indexed copy of on-chain markets
- `bets` — per-bettor positions per market
- `leaderboard` — points/win/loss snapshot
- `events` — raw on-chain event audit log
- (Phase 2) `oracle_submissions`, `oracle_disputes`

## Migrations

Each migration is a numbered SQL file:

```
migrations/
  0001_create_markets.sql
  0002_create_bets.sql
  ...
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
