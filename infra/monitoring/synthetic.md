# iPredict — Synthetic Uptime Monitoring

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## Overview

Synthetic monitoring continuously probes the API from the outside to confirm
the service is up and responding correctly, independent of real user traffic.
It covers two targets:

1. **`GET /healthz`** — the liveness probe. Fast, dependency-free; confirms the
   process is up (`{ "status": "ok" }`).
2. **`GET /api/markets`** — the hot market-list endpoint. A real read path that
   exercises the database (and Redis cache when enabled), so it catches
   "process is up but serving nothing useful" failures that `/healthz` misses.

The full array of HTTP endpoints and their exact response shapes are documented
in [`docs/API.md`](../../docs/API.md).

> **Current state of `infra/`:** as of this writing `infra/` contains only
> `docker-compose.dev.yml` (Postgres + Redis) and this directory. There is **no
> Prometheus or Grafana** configuration yet. Therefore the immediately runnable
> option below is a **shell-script probe** suitable for a cron job or a simple
> agent. The Prometheus Blackbox Exporter configuration is included for the
> planned monitoring stack, ready to adopt when Prometheus is added.

## Shell-script probe (recommended today)

A dependency-free `curl` probe that checks both endpoints and exits non-zero if
either fails. Suitable for a cron job or a minimal monitoring agent.

Save the following as `infra/monitoring/probe.sh`:

```bash
#!/usr/bin/env bash
# Synthetic uptime probe for the iPredict API.
# Exits 0 when both /healthz and /api/markets respond successfully, else 1.
#
# Usage:
#   BASE_URL=http://localhost:4000 ./probe.sh
# Add to cron, e.g. every minute:
#   * * * * * BASE_URL=http://localhost:4000 /opt/ipredict/infra/monitoring/probe.sh

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
HEALTHZ_URL="${BASE_URL}/healthz"
MARKETS_URL="${BASE_URL}/api/markets"

failures=0

# 1. Liveness: /healthz must return 200 with {"status":"ok"}.
healthz_body="$(curl -fsS --max-time 5 -o /tmp/ipredict-healthz-$$.json -w '%{http_code}' "$HEALTHZ_URL")"
if [[ "$healthz_body" == "200" ]] && grep -q '"status":"ok"' /tmp/ipredict-healthz-$$.json; then
  echo "OK  $HEALTHZ_URL"
else
  echo "FAIL $HEALTHZ_URL (http=$healthz_body)"
  failures=$((failures + 1))
fi

# 2. Real endpoint: /api/markets must return 200 with a JSON body containing a
#    "markets" array.
markets_body="$(curl -fsS --max-time 10 -o /tmp/ipredict-markets-$$.json -w '%{http_code}' "$MARKETS_URL")"
if [[ "$markets_body" == "200" ]] && grep -q '"markets"' /tmp/ipredict-markets-$$.json; then
  echo "OK  $MARKETS_URL"
else
  echo "FAIL $MARKETS_URL (http=$markets_body)"
  failures=$((failures + 1))
fi

rm -f /tmp/ipredict-healthz-$$.json /tmp/ipredict-markets-$$.json

[[ "$failures" -eq 0 ]]
```

Run it locally with the API up (see [Running locally](#running-locally)):

```bash
chmod +x infra/monitoring/probe.sh
BASE_URL=http://localhost:4000 ./infra/monitoring/probe.sh
```

Cron integration (check every minute, log to a file):

```cron
* * * * * BASE_URL=http://localhost:4000 /opt/ipredict/infra/monitoring/probe.sh >> /var/log/ipredict-probe.log 2>&1
```

## Prometheus Blackbox Exporter configuration

When Prometheus is added to `infra/`, adopt this configuration. It probes both
targets using the `http_2xx` module and keeps the metrics under
`probe_success` / `probe_duration_seconds` (and, with the probe HTTP module,
`probe_http_duration_seconds`) labels.

**`infra/monitoring/prometheus.yml`** — scrape config:

```yaml
scrape_configs:
  - job_name: 'stellar-ipredict-synthetic'
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
        - http://localhost:4000/healthz
        - http://localhost:4000/api/markets
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
```

> Note the targets resolve to the **actual** backend endpoints on
> `localhost:4000` — `/healthz` (liveness) and `/api/markets` (the hot list
> endpoint, see [`docs/API.md`](../../docs/API.md)).

### Alert rules

**`infra/monitoring/alerts.yml`**:

```yaml
groups:
  - name: stellar-ipredict-synthetic
    rules:
      # Endpoint down for more than 2 minutes
      - alert: IPredictEndpointDown
        expr: probe_success{job="stellar-ipredict-synthetic"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "iPredict endpoint {{ $labels.instance }} is down"

      # Response time above 1s for more than 5 minutes
      - alert: IPredictHighLatency
        expr: probe_duration_seconds{job="stellar-ipredict-synthetic"} > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "iPredict endpoint {{ $labels.instance }} slow (>1s)"
```

> If you use the HTTP probe module (`module: [http_2xx]`), the per-step request
> duration is better measured from `probe_http_duration_seconds_phase` for the
> `connect`/`tls`/`processing` phases rather than `probe_duration_seconds`
> (which is the full Blackbox probe, including DNS). Adjust the latency query
> to your probe module.

## Grafana dashboard (if applicable)

There is currently **no Grafana configuration** in `infra/`. When one is added,
the key panels for this synthetic job are:

- **Uptime %** — `100 * avg_over_time(probe_success{job="stellar-ipredict-synthetic"}[24h])`
- **Response time** (p95 over the probe) —
  `histogram_quantile(0.95, sum(rate(probe_http_duration_seconds_bucket{job="stellar-ipredict-synthetic"}[5m])) by (le, instance))`
  or, without the HTTP module, `metric(probe_duration_seconds{job="stellar-ipredict-synthetic"})`.

## Running locally

To verify the probes work against a live API:

```bash
# 1. Start Postgres + Redis
cd infra
docker compose -f docker-compose.dev.yml up -d

# 2. Start the backend on :4000 (needs DATABASE_URL etc. — see backend/.env.example)
cd ../backend
cp .env.example .env   # edit DATABASE_URL/REDIS_URL if needed
npm install
# DATABASE_URL must point at a seeded/initialised DB, then:
#   (run via tsx, or npm run build && node dist/index.js)
npm run build
node dist/index.js     # serves on http://localhost:4000

# 3. Shell probe (recommended)
cd ../infra
BASE_URL=http://localhost:4000 ./monitoring/probe.sh

# 4. Blackbox path (when Prometheus is set up)
docker run --rm -p 9115:9115 prom/blackbox-exporter --config.file=/etc/blackbox_exporter/blackbox.yml
# then scrape http://localhost:9115/probe?target=http://localhost:4000/healthz&module=http_2xx
```

Expected result for the shell probe:

```
OK  http://localhost:4000/healthz
OK  http://localhost:4000/api/markets
```

with an exit code of `0`. If either line reads `FAIL`, inspect the backend logs
and the targeted endpoint before treating the stack as healthy.
