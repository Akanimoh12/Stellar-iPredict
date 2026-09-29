# iPredict — Backend Stack Deployment Guide

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

> **Scope:** this guide covers deploying the backend stack — the API
> (`backend/`), indexer (`indexer/`), oracle services (`oracle/`), PostgreSQL,
> and Redis — to production. It follows the design in
> [`ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md) and the implementation in
> [`infra/`](../infra). For deploying the Soroban smart contracts and
> frontend, see [`DEPLOYMENT-GUIDE.md`](DEPLOYMENT-GUIDE.md) instead. For the
> local host-based dev workflow, see [`LOCAL_DEV.md`](LOCAL_DEV.md).

## Services deployed

| Service | Image / build context | Replicas | Holds a signing key? |
| --- | --- | --- | --- |
| `postgres` | `postgres:16.4-alpine` | 1 | no |
| `redis` | `redis:7.4-alpine` | 1 | no |
| `api` | `../backend` (`Dockerfile`) | `API_REPLICAS`, default 3 | no |
| `indexer` | `../indexer` (`src/Dockerfile`) | 1, always | no |
| `oracle-aggregator` | `../oracle` (`src/aggregator/Dockerfile`) | 1 | yes — `RESOLVER_KEY` |
| `oracle-monitor` | same image as `oracle-aggregator`, different command | 1 | no (read-only) |
| `log-collector` | `fluent/fluent-bit:3.1.9` | 1 | no |
| `migrate` | `postgres:16-alpine` | on demand (`--profile migrate`) | no |

All of this is defined in
[`infra/docker-compose.production.yml`](../infra/docker-compose.production.yml)
and documented in full in [`infra/README.md`](../infra/README.md).

## Prerequisites

- Docker and Docker Compose on the deployment host.
- Deployed Soroban contract IDs (market, token, referral, leaderboard) — see
  [`DEPLOYMENT-GUIDE.md`](DEPLOYMENT-GUIDE.md).
- A Soroban RPC endpoint for the target network (`SOROBAN_RPC_URL`) and its
  matching `NETWORK_PASSPHRASE`.
- If running the council aggregator: a funded resolver keypair
  (`RESOLVER_KEY`) and the council members' public keys
  (`COUNCIL_MEMBERS`).

## Step 1: Configure secrets

Every value for the stack lives in one file, `infra/.env`, loaded
automatically by Compose:

```bash
cd infra
cp .env.example .env
$EDITOR .env       # replace every CHANGE_ME value
```

Compose refuses to start, naming the missing variable, if any of these are
unset: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`,
`ORACLE_API_KEY`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`,
`MARKET_CONTRACT_ID`, `TOKEN_CONTRACT_ID`, `REFERRAL_CONTRACT_ID`,
`LEADERBOARD_CONTRACT_ID`.

`ORACLE_API_KEY` is required for a specific reason: without it,
`backend/src/api/oracle.ts` falls back to a hard-coded development key, which
would leave `POST /api/v1/oracle/submit` open. Generate secrets, do not
invent them:

```bash
openssl rand -base64 24   # POSTGRES_PASSWORD, REDIS_PASSWORD
openssl rand -hex 32      # ORACLE_API_KEY
```

Keep `POSTGRES_PASSWORD` and `REDIS_PASSWORD` URL-safe
(`A–Z a–z 0–9 . _ ~ -`) — they are interpolated into `postgres://` and
`redis://` connection strings. `chmod 600 infra/.env` once it holds real
values; it is already covered by `.gitignore` and must never be committed.
See ["Configuration and secrets" in `infra/README.md`](../infra/README.md#configuration-and-secrets)
and [`SECURITY_BACKEND.md`](SECURITY_BACKEND.md#key-inventory) for the full
secret inventory and which service each one reaches.

## Step 2: Build and start the stack

```bash
cd infra
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

Postgres applies every migration in [`db/migrations`](../db/migrations) on
the first boot of an empty `pgdata` volume (see "Migrations" below); the
health check waits for that to finish before dependent services start.
Postgres and Redis publish no host port — only the API's port range
(`API_PORT_RANGE`, default `4000-4002`) is reachable from outside the compose
network, one port per replica so a load balancer can address them
individually and a rolling deploy can take one replica down at a time.

### Known issue: the indexer image does not build

This is pre-existing on `implementation-drips`, unrelated to the compose
file: `indexer/` does not typecheck, so its Dockerfile's `npm run build`
step fails (`zod` is used by `indexer/src/config/index.ts` but missing from
`indexer/package.json`; `indexer/src/backfill.ts` imports a `pool` export
`./db.js` does not have; `handlers/claim.ts` and `handlers/reward_points.ts`
pass a `CacheClient` where a `RedisClient` is expected). Reproduce with
`cd indexer && npm run typecheck`. Every other service builds. Bring the rest
of the stack up explicitly while that is unresolved:

```bash
docker compose -f docker-compose.production.yml up -d --build \
  postgres redis api oracle-aggregator oracle-monitor
```

### Using pre-built images

Once images are published to a registry, deploy by tag instead of building
locally. Tags are immutable — a semantic version (`v1.4.0`) for a release, or
`<branch>-<short-sha>` for a branch build. `local` is only for local builds;
never deploy it, and never use `latest`.

```bash
IMAGE_REGISTRY=ghcr.io/akanimoh12 \
API_IMAGE_TAG=v1.4.0 \
INDEXER_IMAGE_TAG=implementation-drips-a1b2c3d \
ORACLE_IMAGE_TAG=v1.4.0 \
docker compose -f docker-compose.production.yml up -d --no-build
```

## Step 3: Verify

```bash
docker compose -f docker-compose.production.yml ps
curl http://localhost:4000/healthz   # { "status": "ok" }
curl http://localhost:4000/readyz    # pings Postgres and Redis
```

The API's `healthcheck` in the compose file calls `/readyz`, so
`docker compose ps` already reflects real DB/Redis connectivity, not just
process liveness. Watch aggregated logs (via Fluent Bit) with:

```bash
docker compose -f docker-compose.production.yml exec log-collector \
  tail -f /var/log/ipredict/containers.log
```

## Migrations

On the first boot of an empty `pgdata` volume, the `postgres` container
applies everything in `db/migrations` in filename order via
[`infra/scripts/init-db.sh`](../infra/scripts/init-db.sh) and records each one
in a `schema_migrations` bookkeeping table. For migrations added later,
against an already-running database, run the opt-in profile:

```bash
docker compose -f docker-compose.production.yml --profile migrate run --rm migrate
```

Both paths are idempotent — an already-applied migration is skipped. See
["Migrations" in `DB_SCHEMA.md`](DB_SCHEMA.md#migrations) for the schema
itself.

## Backups

[`infra/scripts/backup.sh`](../infra/scripts/backup.sh) and
[`restore.sh`](../infra/scripts/restore.sh) wrap `pg_dump`/`pg_restore` with
checksums and safe defaults:

```bash
cd infra
./scripts/backup.sh                        # → infra/backups/ipredict-<UTC>.dump
./scripts/restore.sh --list <dump>         # inspect an archive, change nothing
./scripts/restore.sh <dump>                # restore, with confirmation
```

Schedule backups from host cron (not inside a container — it needs the
Docker socket or a reachable `DATABASE_URL`):

```cron
15 3 * * * cd /srv/ipredict/infra && BACKUP_DIR=/srv/backups ./scripts/backup.sh >> /var/log/ipredict-backup.log 2>&1
```

After a restore, re-run migrations so `schema_migrations` matches the code,
then restart the API and indexer so they reconnect to the rebuilt schema.
Full detail, including retention and restore semantics, is in
["Backups" in `infra/README.md`](../infra/README.md#backups).

## Scaling and resource limits

Each service has CPU and memory ceilings set as starting points — monitor
throttling, OOM restarts, DB working-set size, and indexer lag before
changing them:

| Service | CPUs | Memory |
| --- | --- | --- |
| API | 1.00 | 512 MiB |
| Indexer | 0.75 | 384 MiB |
| Postgres | 1.00 | 1 GiB |
| Redis | 0.50 | 256 MiB |
| Oracle aggregator | 0.50 | 384 MiB |
| Oracle monitor | 0.25 | 256 MiB |
| Fluent Bit | 0.25 | 128 MiB |

The API is the only horizontally-scaled service (`API_REPLICAS`, default 3).
The indexer must stay at exactly one replica — it holds a Postgres
session-level advisory lock (`indexer/src/lock.ts`) so a second instance
fails fast with `IndexerAlreadyRunningError` instead of double-processing
events.

## Monitoring

Prometheus scrapes `/metrics` on the API and indexer; the oracle aggregator
has no HTTP metrics endpoint yet. See
["Monitoring" in `infra/README.md`](../infra/README.md#monitoring) for the
full metric catalogue, Prometheus config, alert rules, and Grafana
dashboards, and ["Oracle Monitoring Requirements" in `ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md#oracle-monitoring-requirements)
for the oracle-specific alert types the `oracle-monitor` service emits.

## Rolling back

To roll back a bad deploy, redeploy the previous immutable image tag for the
affected service:

```bash
API_IMAGE_TAG=v1.3.2 docker compose -f docker-compose.production.yml up -d --no-build api
```

If the rollback also needs a schema rollback, apply the matching
`*.down.sql` file from `db/migrations/` manually — the compose `migrate`
profile only applies forward migrations.

## Staging

[`docker-compose.staging.yml`](../infra/docker-compose.staging.yml) runs the
same stack against Stellar Testnet with isolated volumes and no published
Postgres/Redis ports, for validating a deploy before it reaches production:

```bash
cd infra
cp .env.staging.example .env
docker compose -f docker-compose.staging.yml up --build -d
```

See ["Staging" in `infra/README.md`](../infra/README.md#staging-stellar-testnet)
for what is and is not included there.
