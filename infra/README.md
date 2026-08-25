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
`http://localhost:3000/metrics` (or your configured backend port) to see
all metrics.

#### Indexer Metrics

The indexer exposes Prometheus metrics at `GET /metrics` on port 9090 (or
`$METRICS_PORT` if set) in text exposition format.

**Metrics exposed:**

- `indexer_lag_ledgers` — gauge, difference between latest ledger and indexer
  checkpoint (0 means fully caught up)
- `events_processed_total` — counter, total contract events successfully indexed
- `rpc_errors_total{service, operation}` — counter, failed RPC calls by service
  and operation (e.g. `operation="getEvents"`)

The `service` and `operation` labels are intentionally low-cardinality. Other
services can use the same metric and identify their stable RPC operation with
those labels. Do not attach URLs, errors, transaction hashes, or market IDs.

**Example:** After running the indexer, visit `http://localhost:9090/metrics`
to see all metrics.

### Prometheus Configuration

Configure Prometheus to scrape both services by adding to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "ipredict-backend"
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: "/metrics"
    scrape_interval: 15s

  - job_name: "ipredict-indexer"
    static_configs:
      - targets: ["localhost:9090"]
    metrics_path: "/metrics"
    scrape_interval: 15s
```

Then load [`prometheus/alerts.yml`](prometheus/alerts.yml) from `rule_files`:

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
