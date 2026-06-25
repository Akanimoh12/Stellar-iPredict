# iPredict Backend API

REST API that serves market, bet, leaderboard, and stats data to the frontend —
reading from an indexed PostgreSQL copy of on-chain state (written by the
[`indexer/`](../indexer)) with a Redis cache in front, instead of hitting Soroban
RPC directly on every request.

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## Why this exists

The frontend currently reads markets directly from Soroban RPC. That works for
<100 markets but throttles and slows badly past ~500. This service is the
scalable read path. See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md)
for the full design.

## Stack

- **Runtime:** Node.js 20+, TypeScript
- **HTTP:** Fastify
- **DB:** PostgreSQL 16 (shared with the indexer)
- **Cache:** Redis 7
- **Validation:** Zod
- **Stellar:** `@stellar/stellar-sdk`

## Layout

```
backend/
  src/
    api/         route handlers (markets, leaderboard, stats, oracle)
    db/          query layer (shared schema lives in ../db migrations)
    cache/       Redis client + cache helpers
    config/      env loading & validation
    lib/         shared utilities
    server.ts    Fastify bootstrap
    index.ts     entrypoint
  test/
  package.json
  tsconfig.json
  .env.example
```

## Getting started

```bash
cd backend
cp .env.example .env        # fill in DATABASE_URL, REDIS_URL, contract IDs
npm install
npm run dev                 # starts the API on :4000
```

You need Postgres and Redis running locally (see
[`infra/`](../infra) for a docker-compose that starts both).

## Endpoints (target)

See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#api-endpoints).
Each endpoint is tracked as its own issue.

## Contributing

1. Pick an open issue labelled `area:backend` (or `area:api`).
2. Comment to claim it.
3. Branch off `implementation-drips`, implement, open a PR back to
   `implementation-drips`.
