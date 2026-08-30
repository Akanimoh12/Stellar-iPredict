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
- Postgres on `localhost:5432` (database: ipredict, see docker-compose.dev.yml for credentials)
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

[`docker-compose.production.yml`](docker-compose.production.yml) runs the whole
backend stack. It follows the design in
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#infrastructure).

| Service | What it does | Replicas |
|---|---|---|
| `postgres` | System of record for indexed chain data | 1 |
| `redis` | Cache + rate-limiter store, persisted per [`redis.conf`](redis.conf) | 1 |
| `api` | REST API (`backend/`) | `API_REPLICAS`, default 3 |
| `indexer` | Soroban event indexer (`indexer/`) | 1, always |
| `oracle-aggregator` | Council tally and on-chain finalization (`oracle/`) | 1 |
| `oracle-monitor` | Read-only oracle watchdog and alerting (`oracle/`) | 1 |
| `log-collector` | Aggregates container logs with Fluent Bit | 1 |
| `migrate` | One-shot migration runner, opt-in profile | on demand |

```bash
cd infra
cp .env.example .env          # then fill in every CHANGE_ME value
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

The API replicas take one host port each from `API_PORT_RANGE` (4000–4002 by
default) so a load balancer can address them individually and you can roll one
replica at a time. Postgres and Redis publish no host port at all: they are
reachable only from inside the compose network.

### Single indexer instance

Compose declares one indexer replica, and the indexer additionally uses the
PostgreSQL session-level advisory lock implemented in
[`indexer/src/lock.ts`](../indexer/src/lock.ts). Startup must call
`acquireIndexerLock(pool)` before polling and retain the returned handle for the
process lifetime. If another instance owns the lock, acquisition fails fast
with `IndexerAlreadyRunningError`; the extra instance must exit instead of
processing events. During graceful shutdown, call `lock.release()` before
closing the pool. PostgreSQL releases the lock automatically if the process or
its dedicated connection dies, so a replacement can start without manual
cleanup.
### Runtime and logging policy

Long-running services use `restart: always` and explicit CPU and memory
ceilings. The defaults are starting points; monitor throttling, out-of-memory
restarts, database working-set size, and indexer lag before changing them.

| Service | CPUs | Memory |
|---|---:|---:|
| API | 1.00 | 512 MiB |
| Indexer | 0.75 | 384 MiB |
| Postgres | 1.00 | 1 GiB |
| Redis | 0.50 | 256 MiB |
| Oracle aggregator | 0.50 | 384 MiB |
| Oracle monitor | 0.25 | 256 MiB |
| Fluent Bit | 0.25 | 128 MiB |

Docker sends service logs asynchronously over the local Fluentd protocol to
Fluent Bit at `127.0.0.1:24224`. The collector writes the combined stream to
the `aggregated-logs` volume and uses Docker's size-limited `local` driver
itself to avoid a logging loop. Follow the stream with:

```bash
docker compose -f docker-compose.production.yml exec log-collector \
  tail -f /var/log/ipredict/containers.log
```

The collector configuration lives in
[`logging/fluent-bit.conf`](logging/fluent-bit.conf).

### Container image tags

Application images use immutable tags: semantic versions such as `v1.4.0` for
releases, or `<branch>-<short-sha>` for branch builds. The `local` default is
only for local builds; never publish or deploy it, and never use `latest`.

```bash
IMAGE_REGISTRY=ghcr.io/akanimoh12 \
API_IMAGE_TAG=v1.4.0 \
INDEXER_IMAGE_TAG=implementation-drips-a1b2c3d \
ORACLE_IMAGE_TAG=v1.4.0 \
docker compose -f docker-compose.production.yml up -d --no-build
```

> **Known issue — the `indexer` image does not build today.** This is
> pre-existing on `implementation-drips` and unrelated to the compose file:
> `indexer/` does not typecheck, so its Dockerfile's `npm run build` fails.
> Six errors, three causes — `zod` is imported by
> `indexer/src/config/index.ts` but is not in `indexer/package.json`;
> `indexer/src/backfill.ts` imports a `pool` export that `./db.js` does not
> have; and `handlers/claim.ts` and `handlers/reward_points.ts` pass a
> `CacheClient` where `RedisClient` is expected, whose `del` return types
> disagree. Reproduce with `cd indexer && npm run typecheck`. Every other
> service builds and comes up. Bring the rest up with:
>
> ```bash
> docker compose -f docker-compose.production.yml up -d --build \
>   postgres redis api oracle-aggregator oracle-monitor
> ```

### Why the oracle is two services

`oracle-aggregator` writes — it signs and submits `resolve_market`
transactions, so it holds `RESOLVER_KEY`. `oracle-monitor` only reads Postgres
and posts alerts, so it is given no signing credential at all. Splitting them
means a crash-looping aggregator does not take oracle observability down with
it, which is exactly when you need the alerts.

The two share one image (`ipredict-oracle`) and differ only in their command:
`dist/index.js` versus `dist/monitor/run.js`. Compose builds it once.

The monitor re-runs the read-only checks in `oracle/src/aggregator/` every
`MONITOR_INTERVAL_MS` and emits one alert per finding — logged as JSON, and
POSTed to `ALERT_WEBHOOK_URL` when set:

| Alert `type` | Raised when |
|---|---|
| `oracle.monitor.market_stuck` | A market is unresolved `STUCK_MARKET_HOURS` past expiry |
| `oracle.monitor.submission_new` | A new bonded submission appears |
| `oracle.monitor.dispute_escalated` | A dispute escalates to council |
| `oracle.monitor.bond_below_minimum` | A submission is bonded under `SUBMITTER_BOND_XLM` |
| `oracle.monitor.council_inactive` | An escalated market has no votes after `COUNCIL_INACTIVITY_HOURS` |
| `oracle.monitor.council_window_exceeded` | An escalated market passed the 72h council window |

Two of these are watermarked (`submission_new`, `dispute_escalated`): on
startup the monitor reads the current maxima, so a restart alerts on new
activity only rather than replaying history into your alert channel. A failing
cycle is logged and retried on the next tick — a Postgres blip must not leave
the oracle unwatched.

### Migrations

On the first boot of an empty `pgdata` volume, the postgres container applies
everything in `db/migrations` in filename order and records it in
`schema_migrations` — the same bookkeeping table `db/migrate.ts` uses. The
health check probes over TCP, so dependent services wait for that to finish
before they start.

For migrations added later, against an already-running database:

```bash
docker compose -f docker-compose.production.yml --profile migrate run --rm migrate
```

Both paths run [`scripts/init-db.sh`](scripts/init-db.sh) and both are
idempotent — already-applied migrations are skipped, and each migration
commits together with its bookkeeping row.

## Configuration and secrets

Every value for the production stack lives in **one file**: `infra/.env`,
created from [`.env.example`](.env.example). Compose loads it automatically for
`${VAR}` interpolation, and `docker-compose.production.yml` then hands each
service only the variables that service actually reads.

```bash
cd infra
cp .env.example .env
$EDITOR .env       # every CHANGE_ME value must be replaced
```

That indirection is deliberate. Listing `env_file: .env` on every service would
be shorter, but it would also put the resolver signing key and the data-source
API keys into the API container and into the read-only monitor. Enumerating
variables per service costs a few lines and buys least privilege:

| Secret | Reaches | Deliberately not in |
|---|---|---|
| `POSTGRES_PASSWORD` | postgres, and the composed `DATABASE_URL` | — |
| `REDIS_PASSWORD` | redis, and the composed `REDIS_URL` | indexer's Postgres-only peers |
| `ORACLE_API_KEY` | api | everything else |
| `RESOLVER_KEY` | oracle-aggregator | api, indexer, **oracle-monitor** |
| Adapter API keys | oracle-aggregator | api, indexer, oracle-monitor |

### Where each variable is read

`.env.example` is grouped by service and annotated. The schemas that parse
these are the source of truth, and a name that does not match one of them is
silently ignored rather than rejected:

| Service | Schema |
|---|---|
| api | [`backend/src/config/index.ts`](../backend/src/config/index.ts) |
| indexer | [`indexer/src/config/index.ts`](../indexer/src/config/index.ts) |
| oracle-aggregator | [`oracle/src/aggregator/config.ts`](../oracle/src/aggregator/config.ts) |
| oracle-monitor | [`oracle/src/monitor/config.ts`](../oracle/src/monitor/config.ts) |
| oracle adapters | [`oracle/src/adapters/config.ts`](../oracle/src/adapters/config.ts) |

`infra/.env` is for the container stack. The per-service
`backend/.env.example`, `indexer/.env.example` and `oracle/.env.example` are
for running a single service on the host with `npm run dev` — those stay as
they are.

### Required values

Compose refuses to start, naming the variable, when one of these is unset —
they use the `${VAR:?message}` form rather than defaulting:

`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`,
`ORACLE_API_KEY`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`,
`MARKET_CONTRACT_ID`, `TOKEN_CONTRACT_ID`, `REFERRAL_CONTRACT_ID`,
`LEADERBOARD_CONTRACT_ID`.

`ORACLE_API_KEY` is in that list for a specific reason: `backend/src/api/oracle.ts`
falls back to a hard-coded development key when it is unset, so an unset value
would leave `POST /api/v1/oracle/submit` open rather than disabled.

### Secret handling

- **Never commit `.env`.** It is covered by the root `.gitignore`. Commit
  changes to `.env.example` instead, with the value left blank or as
  `CHANGE_ME_...`.
- **Generate, do not invent.** `openssl rand -base64 24` for passwords,
  `openssl rand -hex 32` for API keys.
- **Keep passwords URL-safe** (`A–Z a–z 0–9 . _ ~ -`). `POSTGRES_PASSWORD` and
  `REDIS_PASSWORD` are interpolated into `postgres://` and `redis://` URLs, so
  `@ : / ? #` would have to be percent-encoded to survive.
- **Permissions.** `chmod 600 infra/.env`. It holds the signing key for an
  account that can resolve markets.
- **Rotation.** Postgres and Redis passwords: change `.env`, then
  `docker compose -f docker-compose.production.yml up -d --force-recreate`.
  `RESOLVER_KEY` rotates through the aggregator's key manager
  (`oracle/src/aggregator/key-rotation.ts`) — rotate the on-chain resolver
  first, then the file.
- **Beyond one host.** `.env` on disk is the right size of tool for a
  single-host compose deployment. Anything larger should mount Docker
  secrets or pull from a manager (Vault, AWS Secrets Manager, SOPS) into the
  same variable names; nothing in the services reads a file path, so the
  substitution is a compose-level change only.
- **Never log a secret.** `restore.sh` redacts the password out of the
  connection string before printing it, and the Redis health check reads
  `REDISCLI_AUTH` from the environment so the password never lands in the
  container's process list. Hold new tooling to the same bar.

## Redis persistence

[`redis.conf`](redis.conf) is mounted read-only into the redis container.
`--requirepass` is appended on the command line so the password stays in the
environment rather than in a tracked file.

Redis holds only regenerable data — cache-aside reads, rate-limiter counters,
negative-cache markers — so it is not a system of record. Persistence is still
configured, for availability rather than durability: a restart with an empty
keyspace sends every in-flight request straight to Postgres and the Soroban
RPC at once.

That is what sets the trade-offs:

| Setting | Value | Why |
|---|---|---|
| `appendonly` | `yes` | Primary recovery path; bounds loss to the last second rather than the last snapshot |
| `appendfsync` | `everysec` | `always` buys durability the data does not need, at a disk round-trip per write |
| `aof-use-rdb-preamble` | `yes` | Rewrites emit an RDB base — smaller file, much faster load |
| `save` | `900 1 / 300 10 / 60 10000` | Point-in-time snapshots; this is what `backup.sh` would copy |
| `stop-writes-on-bgsave-error` | `no` | A disk hiccup must not turn a cache into an API outage. Alert on `rdb_last_bgsave_status` instead |
| `maxmemory-policy` | `allkeys-lru` | Every key is regenerable; `volatile-*` would return OOM once only untyped keys remain |
| `maxmemory` | `512mb` | Raise together with the container's memory limit |

Verify a running instance:

```bash
docker compose -f docker-compose.production.yml exec redis \
  redis-cli CONFIG GET appendonly appendfsync maxmemory-policy save
```

## Backups

[`scripts/backup.sh`](scripts/backup.sh) and
[`scripts/restore.sh`](scripts/restore.sh) wrap `pg_dump`/`pg_restore`.

```bash
cd infra
./scripts/backup.sh                        # → infra/backups/ipredict-<UTC>.dump
./scripts/backup.sh -o /srv/backups -r 14  # custom directory, 14-day retention
./scripts/restore.sh --list <dump>         # inspect an archive, change nothing
./scripts/restore.sh <dump>                # restore, with confirmation
```

Both scripts pick how to run automatically: the local `pg_dump`/`pg_restore`
when `DATABASE_URL` points somewhere reachable, otherwise the pinned client
inside the compose postgres container. `--docker` and `--local` force it.
Auto-selection also covers the version-skew case — `pg_dump` refuses to dump a
server newer than itself, and the host client is routinely older than the
pinned `postgres:16`.

What the scripts guarantee:

- **Custom format** (`-Fc`) — compressed, restorable in parallel, and
  selective.
- **No half-backups.** The dump is written to a `.part` file and renamed only
  after `pg_restore --list` reads the archive back. A truncated file is never
  left looking usable.
- **Checksums.** Every dump gets a `.sha256` sidecar; `restore.sh` verifies it
  before touching the target and refuses on a mismatch.
- **Retention runs last.** Pruning happens only after a verified dump lands,
  so a run of failures can never age out the last good backup.
- **Restore is explicit.** It drops and recreates every object in the dump, so
  it requires typing `restore` at a prompt, or `--yes`. Non-interactively
  without `--yes` it refuses outright.

Schedule it from cron on the host (not in a container — it needs the docker
socket or a reachable `DATABASE_URL`):

```cron
15 3 * * * cd /srv/ipredict/infra && BACKUP_DIR=/srv/backups ./scripts/backup.sh >> /var/log/ipredict-backup.log 2>&1
```

Restore into a scratch database and diff row counts on a schedule. A backup
nobody has restored is a hypothesis, not a backup.

After a restore, re-run migrations so `schema_migrations` matches the code,
then restart the API and indexer so they reconnect to the rebuilt schema.

## Contributing

Pick an open issue labelled `area:infra`, branch off `implementation-drips`,
PR back to `implementation-drips`.

## Monitoring

The monitoring assets use the canonical metric names in
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#monitoring).

### Prometheus metrics and alerts

#### Backend API Metrics

The backend exposes Prometheus metrics at `GET /metrics` in text exposition
format (the standard Prometheus scrape protocol).

**Metrics exposed:**

- `api_request_duration_ms_bucket{route, le}` — request latency histogram
  (cumulative counts per bucket, labeled by route and bucket boundary in ms)
- `api_request_duration_ms_sum{route}` — sum of all request durations
- `api_request_duration_ms_count{route}` — total number of requests
- `api_errors_total{route}` — total number of 5xx responses per route

**Example:** After running the backend for a while, visit
`http://localhost:4000/metrics` (the default port from `backend/.env.example`,
override with `PORT`) to see all metrics.

#### Indexer Metrics

The indexer exposes Prometheus metrics at `GET /metrics` on port 9090 (or
`$METRICS_PORT` if set) in text exposition format. The server binds `0.0.0.0`
(override with `METRICS_HOST`) so a containerized Prometheus can reach it.
When running the indexer on the host alongside the monitoring stack, set
`METRICS_PORT=9091` — the code default 9090 is the same host port the
Prometheus container publishes (see `indexer/.env.example`).

**Metrics exposed:**

- `indexer_lag_ledgers` — gauge, difference between latest ledger and indexer
  checkpoint (0 means fully caught up)
- `events_processed_total` — counter, total contract events successfully indexed
- `rpc_errors_total{service, operation}` — counter, failed RPC calls by service
  and operation (e.g. `operation="getEvents"`)

The `service` and `operation` labels are intentionally low-cardinality. Other
services can use the same metric and identify their stable RPC operation with
those labels. Do not attach URLs, errors, transaction hashes, or market IDs.

**Example:** After running the indexer with `METRICS_PORT=9091`, visit
`http://localhost:9091/metrics` to see all metrics.

### Prometheus Configuration

The scrape config lives at
[`prometheus/prometheus.yml`](prometheus/prometheus.yml) and covers every
service `/metrics` endpoint:

| Job | Local target | Service |
| --- | --- | --- |
| `prometheus` | `localhost:9090` | Prometheus self-scrape |
| `ipredict-backend` | `host.docker.internal:4000` | Backend API, `GET /metrics` |
| `ipredict-indexer` | `host.docker.internal:9091` | Indexer, `GET /metrics` (run it with `METRICS_PORT=9091`) |
| `ipredict-oracle` | `host.docker.internal:9101` | Oracle aggregator — **no HTTP `/metrics` endpoint exists yet** (its `AggregatorMetrics` are in-process only), so this target shows `DOWN` until one lands; the job is pre-provisioned so scraping starts the moment it does |

App services run on the host during local development, so the containerized
Prometheus reaches them via `host.docker.internal`.
`docker-compose.monitoring.yml` maps that name to the host gateway through
`extra_hosts`, which is required on Linux. In a full compose deployment
(`docker-compose.production.yml`), target the Compose service names instead
(e.g. `api:4000`).

The config loads [`prometheus/alerts.yml`](prometheus/alerts.yml) from
`rule_files`. Validate the config and the rules before deploying:

```bash
promtool check config infra/prometheus/prometheus.yml
promtool check rules infra/prometheus/alerts.yml
```

The rules define `IndexerStalled`, `HighRPCErrorRate`, `MarketStuck`,
`HighAPILatency`, and `DatabaseSlow`. The `MarketStuck` rule expects
`market_end_time_seconds{market_id}` and `market_resolved{market_id}` (0 or 1)
to be exported. API and database latency must be Prometheus histograms with
millisecond buckets.

### Production compose notes

The production compose file (`docker-compose.production.yml`) includes container
`healthcheck` entries and uses `depends_on` with `service_healthy` so that
dependent services (API, indexer) wait for Postgres/Redis to be ready. Health
checks are intentionally conservative: services will retry several times before
being considered unhealthy to avoid false starts on noisy hosts.

Bring the stack up with:

```bash
cd infra
docker compose -f docker-compose.production.yml up -d --build
```

If you need to bring an individual component up for debugging (skipping the
indexer build problems), run the subset explicitly:

```bash
docker compose -f docker-compose.production.yml up -d postgres redis api
```

### Grafana dashboards

Import [`grafana/business.json`](grafana/business.json) and
[`grafana/oracle.json`](grafana/oracle.json) and
[`grafana/system.json`](grafana/system.json) in Grafana, selecting the local
Prometheus datasource when prompted. The business dashboard covers market
creation, bets, XLM volume, and resolved markets. The oracle dashboard covers
submissions, disputes, resolution lag, and oracle RPC failures. The system
health dashboard covers scrape target availability, API latency and errors,
indexer lag and throughput, RPC failures, and Postgres/Redis exporter health.

The system dashboard expects the standard `postgres_exporter` and
`redis_exporter` metric names: `pg_up`, `redis_up`, `redis_memory_used_bytes`,
and `redis_commands_processed_total`. Run those exporters beside Postgres and
Redis, then add scrape jobs similar to these (use the exporter hostnames and
ports from your deployment):

```yaml
  - job_name: "ipredict-postgres"
    static_configs:
      - targets: ["postgres-exporter:9187"]

  - job_name: "ipredict-redis"
    static_configs:
      - targets: ["redis-exporter:9121"]
```

The existing `ipredict-backend` and `ipredict-indexer` jobs above provide the
application metrics used by the remaining panels. A panel remains empty until
its service or exporter is scraped and emits the corresponding metric.

For a local smoke test, start Prometheus and Grafana, configure Prometheus to
scrape the services' metrics endpoints and exporters, import the dashboards,
and use
Grafana's query inspector to confirm every panel returns without a PromQL
error. An empty panel is expected until its service emits the corresponding
metric.

### Local Prometheus and Grafana Setup

For local monitoring during development, you can run Prometheus and Grafana
alongside your backend service to visualize business metrics in real-time.

#### Prerequisites

1. Docker and Docker Compose installed
2. At least one app service running on the host with its `/metrics` endpoint:
   - **Backend API** on port 4000 (default from `backend/.env.example`)
   - **Indexer** with `METRICS_PORT=9091` (the code default 9090 collides with
     the Prometheus container's published port) and `METRICS_HOST=0.0.0.0`
   - The **oracle** has no `/metrics` endpoint yet, so its `ipredict-oracle`
     target will show `DOWN` until one is added (pre-provisioned at 9101)

#### Environment Variables (Optional)

You can customize the monitoring setup using environment variables:

```bash
# Option 1: Copy and customize the example file
cd infra
cp .env.monitoring.example .env
# Edit .env with your preferred values

# Option 2: Set environment variable directly
export GRAFANA_ADMIN_PASSWORD=your-secure-password

# Then start the monitoring stack
docker compose -f docker-compose.monitoring.yml up -d
```

#### Quick Start

1. Start the monitoring stack:
```bash
cd infra
docker compose -f docker-compose.monitoring.yml up -d
```

2. Start the app services (in separate terminals), e.g.:
```bash
cd backend
DATABASE_URL=postgres://ipredict:ipredict@localhost:5432/ipredict npx tsx src/index.ts

cd indexer
DATABASE_URL=postgres://ipredict:ipredict@localhost:5432/ipredict \
METRICS_PORT=9091 npx tsx src/index.ts
```

3. Access the services:
   - **Grafana**: http://localhost:3000 (use GRAFANA_ADMIN_PASSWORD env var or default credentials)
   - **Prometheus**: http://localhost:9090
   - **Backend metrics**: http://localhost:4000/metrics
   - **Indexer metrics**: http://localhost:9091/metrics (when the indexer runs)

4. In Grafana, the business dashboard should be automatically available with:
   - Market creation rate
   - Bet placement rate  
   - Total volume (XLM)
   - Total bets placed
   - Resolved markets count

#### Verification Steps

1. **Check Prometheus targets**: 
   - Go to http://localhost:9090/targets
   - Verify `prometheus` and `ipredict-backend` are UP
   - Verify `ipredict-indexer` is UP when the indexer is running with
     `METRICS_PORT=9091`
   - `ipredict-oracle` is expected to be DOWN (no `/metrics` endpoint yet)
   
2. **Test metrics endpoint**:
```bash
curl http://localhost:4000/metrics
```
   Should return Prometheus text format with the backend request histogram, e.g.:
   ```
   api_request_duration_ms_bucket{route="GET /metrics",le="5"} 1
   api_request_duration_ms_sum{route="GET /metrics"} 0.4
   api_request_duration_ms_count{route="GET /metrics"} 1
   ```
   With the indexer running, `curl http://localhost:9091/metrics` returns
   `indexer_lag_ledgers`, `events_processed_total`, and `rpc_errors_total`.

3. **Grafana Dashboard**:
   - Go to http://localhost:3000
   - Login with default credentials (or use your custom GRAFANA_ADMIN_PASSWORD)
   - Navigate to "iPredict Business Metrics" dashboard
   - All panels should load without PromQL errors (values may be 0 initially)

#### Stopping the Stack

```bash
cd infra
docker compose -f docker-compose.monitoring.yml down
```

To remove all monitoring data:
```bash
docker compose -f docker-compose.monitoring.yml down -v
```
