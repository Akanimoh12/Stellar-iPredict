# iPredict Oracle

The resolution layer that decides market outcomes without trusting a single
admin. Built in phases (see [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#part-1--oracle-architecture)):

| Phase | Model | Contract changes |
|---|---|---|
| **1.5** | 4-of-7 Council multisig + off-chain aggregator | none (uses existing `add_resolver`/`resolve_market`) |
| **2** | Optimistic oracle — bonded submissions, challenge window, dispute council | new contract functions & state |
| **Data** | Off-chain data adapters (CoinGecko, Binance, sports, politics) feeding submitters | none |

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## What lives here

- **`aggregator/`** — off-chain service that watches council submissions and
  fires the final on-chain resolution once threshold is met.
- **`adapters/`** — one module per data source; each returns a normalized
  outcome for a given market.
- **`submitter/`** — signs and submits outcomes/bonds on behalf of an oracle
  provider.
- **`monitor/`** — watches oracle events (submissions, challenges, disputes)
  and alerts on stuck/conflicting markets.

> Note: the *contract-side* oracle changes (optimistic oracle state machine,
> bonds, dispute council) live under [`contracts/`](../contracts) as new Soroban
> code, tracked by issues labelled `area:oracle` + `area:contracts`.

## Layout

```
oracle/
  src/
    aggregator/
    adapters/      coingecko.ts, binance.ts, sports.ts, politics.ts, ...
    submitter/
    monitor/
    config/
    index.ts
  test/
  package.json
  tsconfig.json
  .env.example
```

## Getting started

```bash
cd oracle
cp .env.example .env
npm install
npm run dev
```

### Running the monitor

The monitor is the read-only half of the oracle. It re-runs the checks in
`aggregator/` against Postgres every `MONITOR_INTERVAL_MS` and emits an alert
for anything an operator needs to see — stuck markets, new submissions,
escalated disputes, under-minimum bonds, an inactive council. It never signs or
submits a transaction, so it needs no resolver key.

```bash
npm run dev:monitor          # tsx watch, against your local .env
npm run build && npm run start:monitor
```

Alerts are logged as JSON and, when `ALERT_WEBHOOK_URL` is set, POSTed to it.
Delivery failures are logged rather than thrown: an alerting outage must not
stop the monitoring loop.

In production it runs as its own `oracle-monitor` service from the same image
as the aggregator — see
[`infra/README.md`](../infra/README.md#why-the-oracle-is-two-services).

## Documentation

- **[Oracle Provider Integration Contract](../docs/ORACLE_AND_BACKEND.md#part-5--oracle-provider-integration-contract)** — integration guide for oracle providers: authentication, canonical signing, error codes, and client example
- **[Webhook Signature Verification](./docs/WEBHOOK_VERIFICATION.md)** — guide for verifying HMAC-SHA256 signatures on outgoing notifications
- **[Stuck Market Runbook](./docs/STUCK_MARKET_RUNBOOK.md)** — on-call procedure for `oracle.monitor.market_stuck`: diagnosis, remediation, authorization and bond consequences
- **[Council Runbook](./docs/COUNCIL_RUNBOOK.md)** — operational guide for council members and aggregator operators
- **[Architecture Overview](../docs/ORACLE_AND_BACKEND.md)** — design document for oracle and backend systems

## Contributing

Pick an open issue labelled `area:oracle`, claim it, branch off
`implementation-drips`, PR back to `implementation-drips`.

### Aggregator image runbook

Build the production aggregator image from the repository root. The
Dockerfile remains under `oracle/src/aggregator/`, but the root build context
is required because the oracle imports the `@ipredict/shared` workspace.

```bash
docker build -f oracle/src/aggregator/Dockerfile -t ipredict-oracle-aggregator:local .
```

The image runs as the non-root `aggregator` user. Its Docker healthcheck calls
`/health/ready` on `HEALTH_PORT` (9103 by default), so a stale poll loop or an
unready DB/RPC dependency marks the container unhealthy; Prometheus metrics
remain on port 9102.

Run the image with the same environment variables documented in
`oracle/.env.example`.

```bash
docker run --rm --env-file .env ipredict-oracle-aggregator:local
```
