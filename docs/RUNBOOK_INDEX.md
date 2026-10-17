# Runbook Index

This is the single entry point for on-call engineers. Every alert that fires in
production maps to a row in the table below. Follow the link in that row — or,
for webhook-delivered alerts, follow the `runbook_url` field included directly
in the alert payload.

> **Rule:** adding a new alert without a row in this index (and a
> `runbook_url` in the payload) **is not complete**. See the
> [oracle security checklist](../oracle/src/ORACLE_SECURITY_CHECKLIST.md).

---

## Alert → Runbook Map

### Oracle monitor alerts (`oracle/src/monitor/`)

| Alert type | Severity | First step | Runbook |
|---|---|---|---|
| `oracle.monitor.market_stuck` | SEV1 if pool > 0, else SEV2 | Check whether the market holds user funds before touching anything | [Stuck Market Runbook](../oracle/docs/STUCK_MARKET_RUNBOOK.md) |
| `oracle.monitor.submission_new` | Informational | Verify the new submission looks correct; no action needed unless outcome looks wrong | [Optimistic Oracle Runbook § Part 1](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-1--submit-operation) |
| `oracle.monitor.dispute_escalated` | SEV2 | Confirm council members are aware and voting | [Optimistic Oracle Runbook § Part 2](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-2--challenge-operation) |
| `oracle.monitor.bond_below_minimum` | SEV1 | Bond discrepancy touches escrowed funds — open incident immediately | [Optimistic Oracle Runbook § Part 4 — Monitoring](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-4--monitoring) |
| `oracle.monitor.council_inactive` | SEV2 | Contact inactive council members; check aggregator logs | [Council Resolution Runbook — Monitoring & Alerts](../oracle/docs/COUNCIL_RUNBOOK.md#monitoring--alerts) |
| `oracle.monitor.council_window_exceeded` | SEV1 | 72-hour council window has passed with no ruling; funds may be locked | [Council Flow Runbook — Handling Escalated Disputes](../oracle/docs/COUNCIL_FLOW_RUNBOOK.md#handling-escalated-disputes-exceeding-the-council-window) |

### Oracle aggregator alerts (`oracle/src/aggregator/`)

| Alert type | Severity | First step | Runbook |
|---|---|---|---|
| `oracle.aggregator.submit_failed` (SEV1) | SEV1 | Market holds funds and submission is failing — open incident | [Optimistic Oracle Runbook § Part 1](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-1--submit-operation) |
| `oracle.aggregator.submit_failed` (SEV2) | SEV2 | ≥ 5 consecutive failures, no confirmed fund risk — triage within 30 min | [Optimistic Oracle Runbook § Part 1](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-1--submit-operation) |
| `oracle.aggregator.submit_failed` (SEV3) | SEV3 | Likely transient; watch and escalate if it recurs | [Optimistic Oracle Runbook § Error codes](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#error-codes) |
| `oracle.aggregator.ambiguous_tally` | SEV2 | Council split is impossible under correct config; investigate votes | [Council Resolution Runbook — Ambiguous Tallies](../oracle/docs/COUNCIL_RUNBOOK.md#ambiguous-tallies-and-manual-review) |

### Prometheus / infrastructure alerts (`infra/prometheus/alerts.yml`)

| Alert name | Severity | First step | Runbook |
|---|---|---|---|
| `IndexerStalled` | critical | Check indexer logs; indexer lag > 100 ledgers for 10 min | [Indexer Runbook](INDEXER_RUNBOOK.md) |
| `HighRPCErrorRate` | warning | Identify which service; check Stellar RPC node status | [Oracle & Backend Docs — RPC](ORACLE_AND_BACKEND.md) |
| `MarketStuck` | critical | Same procedure as `oracle.monitor.market_stuck` | [Stuck Market Runbook](../oracle/docs/STUCK_MARKET_RUNBOOK.md) |
| `HighAPILatency` | warning | Check backend logs; look for slow DB queries or RPC timeouts | [Backend Deployment Guide](BACKEND_DEPLOYMENT.md) |
| `DatabaseSlow` | warning | Check Postgres slow-query log; look for missing indexes | [DB Schema Reference](DB_SCHEMA.md) |
| `LowCacheHitRate` | warning | Check Redis; look for key-shape change or over-eager invalidation | [Backend Deployment Guide](BACKEND_DEPLOYMENT.md) |
| `OracleMetricsStale` | warning | Oracle metrics collector is stuck; check oracle process health | [Oracle & Backend Docs](ORACLE_AND_BACKEND.md) |
| `OracleAuthFailureMisconfiguredProvider` | warning | Concentrated 4xx from one origin — check recent key rotations | [Secrets Guide](SECRETS.md) |
| `OracleAuthFailureDistributedGuessing` | critical | Distributed key-guessing attack — rotate keys and investigate source IPs | [Secrets Guide](SECRETS.md) · [Secret Rotation](SECRET-ROTATION.md) |

---

## Runbook locations

All runbooks live under `oracle/docs/` (oracle-specific) or `docs/` (shared).
None live inside `oracle/src/` or `oracle/src/aggregator/`.

| File | Contents |
|---|---|
| [`oracle/docs/STUCK_MARKET_RUNBOOK.md`](../oracle/docs/STUCK_MARKET_RUNBOOK.md) | Primary on-call procedure for `oracle.monitor.market_stuck` |
| [`oracle/docs/COUNCIL_RUNBOOK.md`](../oracle/docs/COUNCIL_RUNBOOK.md) | Council voting, severity levels, escalation path, incident response |
| [`oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md`](../oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md) | Bonded oracle: submit, challenge, finalize, monitoring |
| [`oracle/docs/COUNCIL_FLOW_RUNBOOK.md`](../oracle/docs/COUNCIL_FLOW_RUNBOOK.md) | Exercising the council flow by hand (QA / testnet) |
| [`docs/INDEXER_RUNBOOK.md`](INDEXER_RUNBOOK.md) | Indexer: run, backfill, recover, monitor |
| [`docs/LEADERBOARD_REBUILD_RUNBOOK.md`](LEADERBOARD_REBUILD_RUNBOOK.md) | Leaderboard full rebuild procedure |
| [`docs/ORACLE_RUNBOOK.md`](ORACLE_RUNBOOK.md) | Merged oracle overview (council + optimistic) |
| [`docs/SECRET-ROTATION.md`](SECRET-ROTATION.md) | Secret and key rotation procedures |
| [`docs/SECURITY_BACKEND.md`](SECURITY_BACKEND.md) | Backend threat model |
| [`infra/monitoring/synthetic.md`](../infra/monitoring/synthetic.md) | Uptime probes for `/healthz` and `/api/markets` |

---

## Severity quick-reference

| Severity | Definition | First response |
|---|---|---|
| **SEV1** | User funds at risk or locked | Page on-call immediately; open incident channel; name Incident Commander before any on-chain action |
| **SEV2** | Persistent failure, no confirmed fund impact | Alert on-call (channel, not page); triage within 30 min |
| **SEV3** | Likely transient | Log and watch; escalate to SEV2 if it recurs |

Full procedure: [Council Resolution Runbook — Incident Response](../oracle/docs/COUNCIL_RUNBOOK.md#incident-response).

---

## Adding a new alert

Every alert in this system must satisfy three requirements before merge:

1. **A row in this index** mapping the alert type to its runbook section.
2. **A `runbook_url` field in the alert payload** so the link is delivered
   with the alert and survives without this index being open.
3. **A checklist item ticked** in the
   [Oracle Security Checklist](../oracle/src/ORACLE_SECURITY_CHECKLIST.md).

The pull request template enforces point 3. Points 1 and 2 are reviewed by
the PR reviewer. A PR that adds an alert without all three is not mergeable.
