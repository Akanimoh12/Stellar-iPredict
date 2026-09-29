# Local Development Guide

This guide is the fastest way to run the current iPredict stack locally.

## The Short Version

Every command below has a `make` target at the repo root. `make` on its own
lists them all.

```bash
make install      # dependencies for the workspaces, db, and frontend
make env          # create any missing .env from its .env.example
make up           # Postgres + Redis, waits until healthy
make migrate      # apply db/migrations
make seed         # local sample markets, bets, leaderboard rows
make dev-backend  # in one terminal; also dev-indexer, dev-oracle, dev-frontend
make test         # every Node suite
```

Overrides are variables: `make up ENV=staging`, `make logs SERVICE=redis`,
`make migrate DATABASE_URL=postgres://…`. `make db-reset` destroys the volumes
and rebuilds the database from migrations and seed data.

The rest of this document is what those targets do, for when you need to run a
step by hand.

## What Runs Locally

- `infra/` provides Postgres and Redis.
- `indexer/` writes on-chain events into Postgres.
- `backend/` serves the API from the indexed database.
- `oracle/` is optional unless you are working on oracle workflows.
- `frontend/` is the Next.js app.

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- Rust 1.85+ only if you need to rebuild the contracts

## Start Infrastructure

Bring up the local database and cache first:

```bash
cd infra
docker compose -f docker-compose.dev.yml up -d
```

The dev compose file only starts Postgres and Redis. The app services run on the host during development.

## Start The Backend Stack

Open one terminal per service:

```bash
cd indexer
cp .env.example .env
npm run dev
```

```bash
cd backend
cp .env.example .env
npm run dev
```

```bash
cd frontend
cp .env.local.example .env.local
npm run dev
```

If you are working on oracle features, run the oracle service too:

```bash
cd oracle
cp .env.example .env
npm run dev
```

## Suggested Order

1. Start `infra` first so Postgres and Redis are ready.
2. Start `indexer` so the database begins filling with market data.
3. Start `backend` so the API can read from the indexed database.
4. Start `frontend` once the services above are up.
5. Start `oracle` only when you need oracle-specific workflows.

## Useful URLs

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:4000`
- Backend health check: `http://localhost:4000/healthz`
- Backend OpenAPI spec: `http://localhost:4000/api/docs`

## Environment Files

- `infra/docker-compose.dev.yml` uses fixed local ports for Postgres and Redis.
- `indexer/.env.example` must point at the local database and Redis instance.
- `backend/.env.example` must provide the indexed database and Redis URLs.
- `frontend/.env.local.example` contains the public contract and API values the app expects.
- `oracle/.env.example` is only needed for oracle work.

## Troubleshooting

- If the backend cannot connect, confirm Postgres is listening on `5432` and Redis on `6379`.
- If the indexer starts before the database exists, restart it after `docker compose` reports both services healthy.
- If the frontend renders but data is missing, check that the indexer has caught up.
