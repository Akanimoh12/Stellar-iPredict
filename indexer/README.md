# iPredict Soroban Event Indexer

Polls the Soroban RPC `getEvents()` endpoint, decodes contract events
(markets created, bets placed, claims, resolutions, oracle submissions…), and
writes them into PostgreSQL so the [`backend/`](../backend) can serve fast,
indexed reads. Also invalidates the Redis cache on relevant updates.

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## Stack

- **Runtime:** Node.js 22+, TypeScript
- **DB:** PostgreSQL 16 (shared with the backend)
- **Cache:** Redis 7 (invalidation only)
- **Stellar:** `@stellar/stellar-sdk`

## How it works

```
loop every 5s:
  events = rpc.getEvents({ startLedger: checkpoint, contractIds: [...] })
  for each event:
    decode topics + value (scValToNative)
    upsert into markets / bets / leaderboard / events tables
    invalidate affected Redis keys
  save checkpoint = latestLedger
```

See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#soroban-event-indexer)
for the reference implementation and the DB schema.

## Layout

```
indexer/
  src/
    handlers/    one decoder per event type (market_created, bet, claim, ...)
    db/          write queries + checkpoint store
    rpc/         getEvents client + pagination
    config/      env loading
    index.ts     polling loop entrypoint
  test/
  package.json
  tsconfig.json
  .env.example
```

## Getting started

```bash
cd indexer
cp .env.example .env        # fill in DATABASE_URL, SOROBAN_RPC_URL, contract IDs
npm install
npm run dev
```

## Metrics & observability

The indexer maintains lightweight, dependency-free in-process counters in
[`src/metrics.ts`](src/metrics.ts). They can be logged or exported to whatever
sink the deployment uses (see the metric catalogue in
[`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#monitoring)).

| Metric | Type | Description |
| --- | --- | --- |
| `events_processed_total` (`metrics.eventsProcessed`) | counter | Incremented once per contract event the indexer successfully handles. |

**Runbook — reading `events_processed_total`:** the counter lives in process
memory and increments inside the event router (`writeEventToDb`) each time a
recognised event (e.g. `mkt:cancelled`, `referral:reward`) is handled.
Unrecognised events are skipped and not counted. To observe it, read
`metrics.eventsProcessed.get()` from the running process (or wire it into your
metrics exporter); a flat counter while the chain is producing events indicates
the indexer is stalled or only seeing unrecognised event types.

## Soroban RPC Ledger Retention & Backfill Recovery

Soroban RPC nodes retain event history for a bounded retention window (typically 120,960 ledgers, or approximately 7 days at a 5-second ledger cadence).

### Retention Boundary Detection & Alerting
1. **Explicit Detection**: When `START_LEDGER` or the current resume point is older than the oldest ledger retained on the RPC node (`oldestLedger`), `RetentionExceededError` is raised distinctly from transient network failures.
2. **Unavailable Range Reporting**: The error explicitly reports the exact missing ledger range (e.g. `[5000..99999]`), naming the unrecoverable interval rather than failing opaquely.
3. **Approaching Retention Alerts**: The indexer queries node health and monitors the margin (`currentLedger - oldestLedger`). When this margin falls below `DEFAULT_RETENTION_ALERT_THRESHOLD` (17,280 ledgers, or ~24 hours), high-priority warning alerts are raised (`ALERT: Approaching Soroban RPC retention boundary!`) to give operators time to intervene before data loss occurs.

### Disaster Recovery Runbook: Gap Beyond Retention
Once a ledger gap exceeds the node's retention window, the pruned events cannot be retrieved from standard Soroban RPC `getEvents()`. Follow one of these recovery procedures:

1. **Option 1: Database Snapshot Restoration (Recommended)**
   - Restore the PostgreSQL database from a backup or snapshot taken at or after the gap's `startLedger`.
   - Resume the indexer from the snapshot checkpoint (`SELECT last_ledger_seq FROM checkpoints WHERE id = 0`).
2. **Option 2: Archival Node / Ingestion Service**
   - Connect the backfill job to an archival Stellar RPC or Hubble/Horizon instance configured with extended history retention.
   - Run backfill across the unavailable ledger range (`START_LEDGER=<fromLedger> npm run backfill`).
3. **Option 3: Fast-Forward & State Rebuild**
   - If historical events prior to `oldestLedger` are expendable or state can be derived, update `START_LEDGER` in the environment to the node's `oldestLedger`.
   - Run the leaderboard rebuild job to reconcile rankings:
     ```bash
     npm run rebuild:leaderboard -- --since-ledger <oldestLedger>
     ```
   - Restart the indexer to resume live polling.

## Checkpoint Atomicity & Event Processing Guarantees

The indexer enforces deliberate transactional guarantees to ensure data integrity during process crashes and restarts.

### Atomicity Guarantee
- **Atomic Persistence**: In transactional environments, `processEventsWithCheckpoint` commits all event effects and the updated cursor ledger in a single PostgreSQL transaction (`BEGIN ... COMMIT`).
- **Deliberate Ordering**: Where full single-transaction atomicity across disparate sinks is impractical, event effects are committed **before** the cursor position is updated. Under no circumstances is the cursor advanced before the effects it accounts for.

### Crash Recovery & Handler Idempotency
- **Never Skip Events**: A mid-batch crash leaves the database checkpoint at the last successfully completed batch. On recovery, the indexer resumes from `checkpoint + 1`, re-fetching the batch.
- **Idempotent Reprocessing**: Because all event handlers enforce idempotency via the `events (tx_hash, event_index)` unique constraint and `ON CONFLICT DO NOTHING`, reprocessing events after a crash never causes duplicated effects or balance inflation.

## Contributing

Pick an open issue labelled `area:indexer`, claim it, branch off
`implementation-drips`, and PR back to `implementation-drips`.

