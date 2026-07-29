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

## Production

`docker-compose.production.yml` (tracked as its own issue) builds and runs the
API (replicated), the single indexer, Postgres, and Redis. See
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#infrastructure).

## Contributing

Pick an open issue labelled `area:infra`, branch off `implementation-drips`,
PR back to `implementation-drips`.
