# iPredict — Indexer Operations Runbook

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

> **Scope:** this runbook is accurate to the indexer code on `implementation-drips`
> at the time of writing. The authoritative design reference is
> [`docs/ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md#soroban-event-indexer);
> when the two disagree, the source under `indexer/src/` wins.

## Overview

The indexer is a Node.js + TypeScript service that polls the Soroban RPC
`getEvents()` endpoint, decodes contract events (markets created, resolved,
cancelled; bets placed; claims; referral rewards; token mints), and writes them
into PostgreSQL so the [`backend/`](../backend) can serve fast, indexed reads
instead of hitting Soroban RPC on every request. It also invalidates the Redis
cache keys that the backend reads, so fresh on-chain state is reflected in the
API.

The indexer is a **single-process** service: exactly one instance should write
to the shared database. It is not horizontally scalable, because each event
must be applied exactly once and the checkpoint is stored in the shared DB.

### Code layout

```
indexer/
  src/
    index.ts            leaderboard-rebuild job entrypoint (+ Indexer class)
    poll-loop.ts        polling loop (pollOnce / runPollLoop)
    event-router.ts     routes a decoded event to its handler
    handlers/           one handler per recognised event type
    rpc/getEvents.ts    getEvents client, cursor pagination, gap detection
    rpc/retry.ts        RPC retry with exponential backoff + jitter
    config/index.ts     env loading + validation (Zod)
    metrics.ts          in-process counters/gauge
    db.ts               query/close interfaces
    deadLetter.ts       dead-letter queue table + writer
    backfill.ts         historical event backfill (runBackfill)
    backfill-bet-count.ts  bet_count repair job
    leaderboard-rebuild.ts  leaderboard snapshot rebuild
    recomputeTotals.ts      recompute market totals from bets
    recomputeBetCounts.ts   recompute market bet_count from bets
```

## Prerequisites

### Environment variables

Every variable below is read and validated by `indexer/src/config/index.ts`
(and, where noted, by individual modules). Variables are read from
`process.env` — see `indexer/.env.example`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string (shared with the backend). |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis used for cache invalidation. |
| `SOROBAN_RPC_URL` | **yes** | — | Soroban RPC endpoint the indexer polls. |
| `NETWORK_PASSPHRASE` | **yes** | — | Stellar network passphrase for the network being indexed. |
| `MARKET_CONTRACT_ID` | **yes** | — | Stellar contract ID of the prediction-market contract. |
| `TOKEN_CONTRACT_ID` | **yes** | — | Stellar contract ID of the IPREDICT token contract. |
| `REFERRAL_CONTRACT_ID` | **yes** | — | Stellar contract ID of the referral-registry contract. |
| `LEADERBOARD_CONTRACT_ID` | **yes** | — | Stellar contract ID of the leaderboard contract. |
| `POLL_INTERVAL_MS` | no | `5000` | Sleep between poll iterations (positive integer). |
| `EVENTS_PER_PAGE` | no | `200` | Max events fetched per `getEvents` page (positive integer). |
| `START_LEDGER` | no | `0` | Ledger to begin indexing from when no checkpoint exists (`0` = earliest available). |
| `CONTRACT_IDS` | * | — | Comma-separated allowlist of Stellar contract IDs for the poll loop (`contract-filter.ts`). Required when the poll loop runtime is used. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

> `MARKET_CONTRACT_ID` and friends are validated at config-load time and are
> required for the indexer to start. `CONTRACT_IDS` is required by
> `loadContractAllowlist` when the poll-loop runtime is wired up.

### External service dependencies

- **PostgreSQL** (16) — shared with the backend. Schema lives in
  [`db/migrations`](../db/migrations); applied in filename order.
- **Redis** (7) — cache invalidation only; the indexer does no reads from it.
- **Soroban RPC** — must serve `getEvents` and `getLatestLedger`. Public nodes
  rate-limit (~50 req/s per IP), so the retry logic in `rpc/retry.ts` is what
  keeps the indexer making progress under throttling.

### Local infrastructure

Start Postgres + Redis with the dev compose file before running the indexer:

```bash
cd infra
docker compose -f docker-compose.dev.yml up -d
```

## Running the Indexer

> **Note on entrypoints.** The production image (and the `dev`/`start`/`start`
> scripts) run `src/index.ts`. As of this writing, the `main()` in that file
> runs the **leaderboard rebuild** job (see [Maintenance jobs](#maintenance-jobs)).
> The live polling loop is assembled from the `Indexer` class
> (`src/index.ts`), `poll-loop.ts`, and `event-router.ts` by the runtime that
> composes the real Postgres/Redis/RPC clients. Use the commands below
> accordingly, and see [`docs/ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md)
> for the reference wiring.

### Development

```bash
cd indexer
cp .env.example .env        # fill in DATABASE_URL, SOROBAN_RPC_URL, contract IDs
npm install
npm run dev                 # tsx watch src/index.ts
```

### Production

Build and start the production image (the Dockerfile lives under
`indexer/src/` so the build context includes `package-lock.json` and the full
source):

```bash
cd indexer
docker build -f src/Dockerfile -t ipredict-indexer:local .
docker run --rm --env-file .env ipredict-indexer:local
```

The image runs `node dist/index.js` as its `CMD`, so `npm run build` must
produce `dist/index.js` (the image runs `npm run build` during the build
stage).

## Backfill Mode

### Bet-count backfill (maintenance job)

`markets.bet_count` is maintained incrementally as bet events are indexed, and
can drift if events are reprocessed or the `bets` table is repaired out of
band. Recompute it from the authoritative `bets` table:

```bash
cd indexer

# Validate drift without writing (runs inside a rolled-back transaction)
npm run backfill:bet-count -- --dry-run

# Apply
npm run backfill:bet-count
```

Set `DATABASE_URL` before running; `LOG_LEVEL` controls the structured JSON
output volume.

### Historic event backfill

`runBackfill()` in `src/backfill.ts` replays events from `config.START_LEDGER`
(or the configured `START_LEDGER`) to the network head, processing each
`getEvents` page and writing `markets`, `bets`, and the `events` audit log. Use
it after a fresh deploy, a data wipe, or a ledger reorg.

- `START_LEDGER` sets the ledger to start from. With no explicit value this
  defaults to `0` (earliest available).
- Pages are advanced via the RPC `cursor`, so backfill respects
  `EVENTS_PER_PAGE`.
- Retry behaviour mirrors the polling loop: transient failures (429, 5xx,
  network) retry with exponential backoff via `fetchWithRetry`.

## Recovery Procedures

### Indexer stalled (lag alert)

**Detect:** `metrics.indexerLag` (see [Monitoring](#monitoring)) is large and
growing, or the log shows no `"poll summary"`/`"poll iteration complete"` lines
for a while. A flat `eventsProcessed` counter while the chain is producing
events is the tell.

**Restart:** bring the process down gracefully with `SIGTERM`/`SIGINT` (the
indexer flushes its checkpoint and closes DB/Redis on `flushAndClose`), then
start it again with the same `START_LEDGER`/`POLL_INTERVAL_MS` env so it picks
up from the persisted checkpoint.

**Confirm recovery:** watch the log for a fresh `"poll summary"` line with a
small/declining `lagLedgers` and a rising `eventsProcessed`.

### RPC node down

**Behaviour:** `rpc/retry.ts` retries transient failures (network errors,
timeouts, 5xx, 429) up to `maxRetries` (5) with exponential backoff + jitter,
honouring a `Retry-After` header, capped at `maxDelayMs` (30s). If every
attempt is exhausted, the error propagates; the polling loop logs
`"poll iteration failed"` and sleeps `POLL_INTERVAL_MS` before trying again.
The indexer does **not** crash — it keeps looping and resumes automatically
when the node returns.

**Manual intervention:** usually none. If a `LedgerGapError` is raised (the RPC
reports `startLedger` older than its oldest retained ledger), that is a
permanent, non-retried failure — see [Cursor reset](#cursor-reset).

### Database connectivity lost

**Behaviour:** writes fail and the event is routed to the dead-letter table
(`dead_letter_events`) if the failure is per-event, or the poll iteration logs
an error and is retried after the poll interval. A total DB outage surfaces as
repeated `"poll iteration failed"`/DB errors; the process keeps looping.

**Recovery:**
1. Restore Postgres (or fix the network).
2. Confirm the `markets`, `bets`, `events`, `leaderboard`, and
   `dead_letter_events` tables are present and consistent.
3. Restart the indexer; it resumes from the last checkpoint.
4. Inspect `dead_letter_events` for rows buffered during the outage and replay
   them if needed.

### Cursor reset

The indexer persists its cursor as a single checkpoint ledger in the shared
database; on start it reads that checkpoint and indexes from `checkpoint + 1`.
To re-index from a specific ledger, reset the checkpoint to `ledger - 1` (so
the next poll starts at your target ledger), for example:

```sql
-- Set the checkpoint so the next poll starts at ledger 1234567890
UPDATE indexer_checkpoint SET ledger_seq = 1234567890 - 1 WHERE TRUE;
-- (Table/row shape depends on the checkpoint store implemented in the runtime.)
```

Where a full reprocess is warranted, run the leaderboard rebuild from a known
ledger instead:

```bash
cd indexer
npm run rebuild:leaderboard -- --since-ledger 1234567890 --dry-run   # preview
npm run rebuild:leaderboard -- --since-ledger 1234567890             # apply
```

> Note: `src/backfill.ts` (historic backfill) reads `START_LEDGER` directly
> rather than the checkpoint, so it can also be used to reprocess from a chosen
> ledger.

## Maintenance Jobs

### Leaderboard rebuild

Rebuilds the `leaderboard` snapshot from the `events` audit log:

```bash
cd indexer
npm run rebuild:leaderboard -- --dry-run           # validate without mutating
npm run rebuild:leaderboard -- --since-ledger 123  # replay from a ledger onward
npm run rebuild:leaderboard                        # full rebuild
```

The job clears `leaderboard` and re-inserts derived rows in score order. It
prints a structured `"poll summary"` with `eventsProcessed` and `lagLedgers`.

### Totals recompute

`recomputeMarketTotalsFromBets` (in `recomputeTotals.ts`) recomputes
`total_yes`/`total_no` on `markets` from the `bets` table. It runs after each
poll iteration when the runtime is started with `recomputeTotals` enabled
(`IndexerRuntime.recomputeTotals`).

### Bet-count recompute

`recomputeMarketBetCountsFromBets` (in `recomputeBetCounts.ts`) recomputes
`markets.bet_count`. See [Backfill mode](#backfill-mode); it also runs per poll
iteration when `recomputeBetCounts` is enabled.

## Monitoring

### Log format

The indexer emits **JSON-lines** logs via `src/log.ts`:

```json
{ "timestamp": "2026-08-28T00:00:00.000Z", "level": "info",
  "message": "poll summary",
  "eventsProcessed": 12, "lagLedgers": 0, "durationMs": 42,
  "lastLedgerSeq": 1234, "checkpointLedger": 1233 }
```

Key messages:
- `poll summary` — iteration summary (events, lag, duration, ledger sequence).
- `poll iteration complete` / `poll iteration failed` — low-level loop events.
- `indexer run started` / `indexer run failed` / `indexer fatal` — job lifecycle.
- `[backfill] …` — backfill progress.

### Detecting lag

The indexer exposes in-process metrics in `src/metrics.ts`:

| Metric | Type | Description |
| --- | --- | --- |
| `events_processed_total` (`metrics.eventsProcessed`) | counter | Events the indexer successfully handled. A flat value while the chain is producing events indicates a stall. |
| `indexer_lag_ledgers` (`metrics.indexerLag`) | gauge | Difference between the RPC's latest ledger and the checkpoint ledger. Computed in `poll-once.ts` as `latestLedger - checkpoint`. |

These are dependency-free in-process values; wire them into whatever sink the
deployment uses (Prometheus text format, JSON log, etc.). See the metric
catalogue in [`docs/ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md#monitoring).

### Uptime checks

For liveness/readiness of the overall stack, see the synthetic monitoring
configuration in [`infra/monitoring/synthetic.md`](../infra/monitoring/synthetic.md).

## Known Failure Modes

| Symptom | Root cause | Action |
| --- | --- | --- |
| Never catches up; `lagLedgers` grows | RPC rate limiting at high event volume | Increase `POLL_INTERVAL_MS`; rely on retry backoff; use a private/faster RPC node. |
| `LedgerGapError` / “startLedger … older than the oldest ledger” | Ledger reorg or RPC retention window passed | Re-backfill from a snapshot or `npm run rebuild:leaderboard --since-ledger <n>`; do **not** just restart. |
| Flat `eventsProcessed` but chain advancing | Indexer stalled or only seeing unrecognised event types | Confirm logs; restart; check the RPC node. |
| Repeated DB write errors | Postgres/Redis connectivity loss | Restore services; inspect `dead_letter_events`; restart. |
| `bet_count`/totals look wrong | Drift from reprocessing or out-of-band repairs | Run `backfill:bet-count` / enable `recomputeTotals`+`recomputeBetCounts`. |
