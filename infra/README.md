# iPredict Infrastructure

Local-dev and production infrastructure for the backend stack: Postgres, Redis,
the API service, the indexer, and the oracle services.

> **Branch:** all work happens on `implementation-drips`.

## Local development

Start Postgres + Redis (enough to run the backend and indexer locally):

```bash
cd infra
docker compose -f docker-compose.dev.yml up -d
```

This gives you:
- Postgres on `localhost:5432` (db `ipredict`, user/pass `ipredict`)
- Redis on `localhost:6379`

Then run each service from its own folder (`backend/`, `indexer/`, `oracle/`)
with `npm run dev`.

## Staging (Stellar Testnet)

The staging compose file uses isolated persistent volumes and points the oracle
at Stellar Testnet (`Test SDF Network ; September 2015`). It deliberately does
not publish Postgres or Redis ports to the host.

```bash
cd infra
cp .env.staging.example .env
# Edit .env and set a non-default POSTGRES_PASSWORD and the contract ID.
docker compose -f docker-compose.staging.yml up --build -d
docker compose -f docker-compose.staging.yml ps
```

Follow service output with `docker compose -f docker-compose.staging.yml logs
-f oracle`. To stop staging without deleting its database/cache volumes, run
`docker compose -f docker-compose.staging.yml down`. Add `-v` only when a
complete staging data reset is intended.

The oracle container is included now so adapter configuration is validated in
the same network and environment used for testnet resolution. API and indexer
containers will be added with their respective runtime images; they are not
defined here because neither service currently ships a runnable container image.

## Production

`docker-compose.production.yml` (tracked as its own issue) builds and runs the
API (replicated), the single indexer, Postgres, and Redis. See
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#infrastructure).

## Contributing

Pick an open issue labelled `area:infra`, branch off `implementation-drips`,
PR back to `implementation-drips`.
