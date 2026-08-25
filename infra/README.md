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

`docker-compose.production.yml` builds and runs the API, the single indexer,
Postgres, Redis, and a Fluent Bit log collector. See
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#infrastructure).

Create a production environment file and replace every placeholder before
deploying:

```bash
cd infra
cat > .env.production <<'EOF'
POSTGRES_USER=ipredict
POSTGRES_PASSWORD=
POSTGRES_DB=ipredict
DATABASE_URL=
SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
MARKET_CONTRACT_ID=replace-me
TOKEN_CONTRACT_ID=replace-me
REFERRAL_CONTRACT_ID=replace-me
LEADERBOARD_CONTRACT_ID=replace-me
EOF

docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.yml ps
```

`DATABASE_URL` and `POSTGRES_PASSWORD` are required and have no defaults. Keep
their password values synchronized and URL-encode special characters in
`DATABASE_URL`. The placeholder contract IDs are not suitable for a real
indexer deployment. Stop the stack with:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml down
```

### Runtime policies

Every production service has an explicit CPU and memory ceiling and uses
`restart: always`, including the data stores and log collector. The limits are
deliberately conservative starting points:

| Service | CPUs | Memory |
|---|---:|---:|
| API | 1.00 | 512 MiB |
| Indexer | 0.75 | 384 MiB |
| Postgres | 1.00 | 1 GiB |
| Redis | 0.50 | 256 MiB |
| Fluent Bit | 0.25 | 128 MiB |

Monitor throttling, out-of-memory restarts, database working-set size, and
indexer lag before changing these values.

### Centralized container logs

Docker sends service logs over the local Fluentd protocol to Fluent Bit at
`127.0.0.1:24224`. Fluent Bit enriches every record with `application=ipredict`
and `environment=production`, then writes the combined stream to the named
`aggregated-logs` volume. The logging driver uses asynchronous connection mode,
so a collector restart does not prevent application containers from starting.
Fluent Bit itself uses Docker's size-limited `local` driver to avoid a logging
loop.

Inspect or follow the central stream with:

```bash
docker compose -f docker-compose.production.yml exec log-collector \
  tail -f /var/log/ipredict/containers.log
```

The collector configuration lives in [`logging/fluent-bit.conf`](logging/fluent-bit.conf).
To send logs to a hosted sink later, add the provider's Fluent Bit output and
credentials without changing application services.

### Container image tags

Application images follow this immutable tag convention:

- Release builds: semantic version, for example `v1.4.0`.
- Branch/commit builds: `<branch>-<short-sha>`, for example
  `implementation-drips-a1b2c3d`.
- Local builds: `local`; never publish or deploy this tag.

Do not publish or deploy mutable tags such as `latest`. Pin third-party images
to a specific version. Set one application tag or registry independently when
bringing up an already-published stack:

```bash
IMAGE_REGISTRY=ghcr.io/akanimoh12 \
API_IMAGE_TAG=v1.4.0 \
INDEXER_IMAGE_TAG=implementation-drips-a1b2c3d \
docker compose --env-file .env.production -f docker-compose.production.yml up -d --no-build
```

## Contributing

Pick an open issue labelled `area:infra`, branch off `implementation-drips`,
PR back to `implementation-drips`.

## Monitoring

The monitoring assets use the canonical metric names in
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#monitoring).

### Prometheus metrics and alerts

The indexer records each failed Soroban RPC request as:

```text
rpc_errors_total{service="indexer",operation="getEvents"} 1
```

The `service` and `operation` labels are intentionally low-cardinality. Other
services can use the same metric and identify their stable RPC operation with
those labels. Do not attach URLs, errors, transaction hashes, or market IDs.

Load [`prometheus/alerts.yml`](prometheus/alerts.yml) from `rule_files` in
`prometheus.yml`:

```yaml
rule_files:
  - /etc/prometheus/alerts.yml
```

Validate the rules before deploying:

```bash
promtool check rules infra/prometheus/alerts.yml
```

The rules define `IndexerStalled`, `HighRPCErrorRate`, `MarketStuck`,
`HighAPILatency`, and `DatabaseSlow`. The `MarketStuck` rule expects
`market_end_time_seconds{market_id}` and `market_resolved{market_id}` (0 or 1)
to be exported. API and database latency must be Prometheus histograms with
millisecond buckets.

### Grafana dashboards

Import [`grafana/business.json`](grafana/business.json) and
[`grafana/oracle.json`](grafana/oracle.json) in Grafana, selecting the local
Prometheus datasource when prompted. The business dashboard covers market
creation, bets, XLM volume, and resolved markets. The oracle dashboard covers
submissions, disputes, resolution lag, and oracle RPC failures.

For a local smoke test, start Prometheus and Grafana, configure Prometheus to
scrape the services' metrics endpoints, import both dashboards, and use
Grafana's query inspector to confirm every panel returns without a PromQL
error. An empty panel is expected until its service emits the corresponding
metric.
