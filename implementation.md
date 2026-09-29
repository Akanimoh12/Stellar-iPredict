# Indexer event handler idempotency (#500)

## Implemented behavior

The implementation covers 15 event paths: bet placement, claim, fee withdrawal,
market creation/resolution/cancellation, Oracle submission/challenge/escalation/
finalization, referral registration/reward, reward points, token mint and transfer.
The fast replay suite contains 14 tests because challenge and escalation share a
scenario; that is not the number of event paths.

For handlers with multiple database statements, `processEventAtomically()` in
`indexer/src/handlers/idempotency.ts` inserts the event marker and runs all derived
writes inside one transaction. `inTransaction()` leases one connection from a
pool, commits on success, rolls back on failure, and releases the connection.
Duplicates are identified by the unique `(tx_hash, event_index)` index and skip
all derived writes. If an effect fails, its marker is rolled back too, allowing a
retry to finish the event.

`bet_placed` already uses an atomic CTE: the inserted event gates the position
upsert and market aggregates. Fee withdrawal only records an event and invalidates
cache; it has no derived database mutation. The legacy backfill writer also uses
the transaction helper and propagates marker failures instead of continuing with
unguarded additive writes.

Enclosing batches must use `withTransaction()` from `indexer/src/db.ts`. Nested
handler work uses a savepoint, so a later batch failure still rolls back successful
handler writes. Query-only adapters must represent dedicated connections; pool
adapters must preserve `connect()`. The dead-letter replay adapter does so.

## Correctness fixes found through real SQL tests

- Market creation records a marker with a null market reference, then creates the
  market and links the event within the same transaction. This satisfies the
  immediate foreign key without losing the deduplication gate.
- Oracle submission and dispute writes use the schema's uppercase `YES`/`NO`
  values, while existing decoded payload formats remain compatible.
- Token transfers cast the debit parameter to `NUMERIC` and commit the marker,
  debit, and credit together.
- The mock replay suite tests the mint implementation used by the dispatcher,
  models sender debits correctly, and understands the different leaderboard SQL
  parameter layouts. Transfer assertions verify actual expected balances.

## Verification

`indexer/test/idempotency-postgres.test.ts` applies the real migrations in an
isolated PostgreSQL schema and contains 31 tests:

- 15 first-result and duplicate-replay cases, asserting expected database values
  and complete unchanged table snapshots after replay.
- 14 failure-and-retry cases, asserting that failed effects leave the database
  unchanged and retries apply the effect exactly once. Multi-write handlers fail
  on a later write to exercise rollback of earlier effects.
- Concurrent duplicate deliveries over separate pool connections.
- Rollback of successful handler writes when an enclosing batch fails.

The fee-withdrawal path has no derived database write to fail. Bet placement is
one SQL statement; its failure case rejects that statement. The other cases
exercise the multi-statement transaction boundary.

The fast replay suite and `indexer/test/replay.test.ts` remain supplementary mock
checks. PostgreSQL tests skip when no database URL is configured and fail on
connection/migration errors when one is supplied. CI provides a database URL.

```bash
npm run typecheck --workspace=ipredict-indexer
npm test --workspace=ipredict-indexer
DATABASE_URL=postgres://... npm test --workspace=ipredict-indexer -- --coverage
npm run test:cross
```

## Scope and limits

These guarantees concern PostgreSQL state. Redis invalidation is a separate
operation and is not atomic with the database commit. A crash after commit can
leave caches stale until expiry or another invalidation. These tests do not claim
to prove arbitrary out-of-order event delivery, or recover previously lost events
whose markers were committed by older code.

Indexed B-tree lookups are O(log N), not O(1). Event storage grows with the number
of retained events; handler auxiliary memory is constant for a bounded payload.
Contributor instructions are in `indexer/README.md`.
