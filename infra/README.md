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

### Local Prometheus and Grafana Setup

For local monitoring during development, you can run Prometheus and Grafana
alongside your backend service to visualize business metrics in real-time.

#### Prerequisites

1. Backend service running locally on port 3001 (default for `npm run dev`)
2. Docker and Docker Compose installed

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

2. Start your backend service (in a separate terminal):
```bash
cd backend
npm run dev
```

3. Access the services:
   - **Grafana**: http://localhost:3000 (use GRAFANA_ADMIN_PASSWORD env var or default credentials)
   - **Prometheus**: http://localhost:9090
   - **Backend metrics**: http://localhost:3001/api/metrics

4. In Grafana, the business dashboard should be automatically available with:
   - Market creation rate
   - Bet placement rate  
   - Total volume (XLM)
   - Total bets placed
   - Resolved markets count

#### Verification Steps

1. **Check Prometheus targets**: 
   - Go to http://localhost:9090/targets
   - Verify `ipredict-backend` target is UP
   
2. **Test metrics endpoint**:
```bash
curl http://localhost:3001/api/metrics
```
   Should return Prometheus format with business counters like:
   ```
   markets_created_total 0
   bets_placed_total 0
   volume_xlm_total 0
   markets_resolved_total 0
   ```

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
