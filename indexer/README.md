# iPredict Soroban Event Indexer

Polls the Soroban RPC `getEvents()` endpoint, decodes contract events
(markets created, bets placed, claims, resolutions, oracle submissions…), and
writes them into PostgreSQL so the [`backend/`](../backend) can serve fast,
indexed reads. Also invalidates the Redis cache on relevant updates.

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## Stack

- **Runtime:** Node.js 20+, TypeScript
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

## Contributing

Pick an open issue labelled `area:indexer`, claim it, branch off
`implementation-drips`, and PR back to `implementation-drips`.
