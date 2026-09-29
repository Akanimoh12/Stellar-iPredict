# Data Retention & Deletion Policy

Issue #646. Several tables grow without bound — `events`, `dead_letter_events`,
`oracle_submissions`, audit records. Holding data indefinitely with no stated
policy is both a storage cost and a liability. This document is the stated
position: what is kept, for how long, and why.

## Two classes of data

| Class | Meaning | Deletion |
|---|---|---|
| **operational** | Needed to run the platform day to day. Loses all value once nothing reads it. | Automatic, on a schedule. |
| **audit** | The record of how a market resolved and was disputed. A dispute or inquiry can surface years later. | Manual, legal review only. Never touched by the automatic job. |

The machine-readable copy of this table lives in the `data_retention_policies`
table (migration `0018_data_retention.sql`) — query it from `psql`:

```sql
SELECT category, class, retention, justification FROM data_retention_policies ORDER BY class, category;
```

## Policy

| Category | Target | Class | Retention | Justification |
|---|---|---|---|---|
| `events_hot` | `events` | operational | 30 days | Replay/backfill only need recent events in the hot table. Older rows are **archived**, not deleted. |
| `events_archive` | `events_archive` | operational | 400 days | Bounds archive growth. Set ≥ the RPC event-retention window so chain replay + archive together cover all reconstructible state; older state is recovered from backups (#648), not chain. |
| `dead_letter_events` | `dead_letter_events` | operational | 90 days | Decode failures exist to debug the indexer. 90 days is enough to notice, fix, and re-drive; after that they carry no value. |
| `idempotency_keys` | `idempotency_keys` | operational | 24 hours (hard ceiling) | Retry-deduplication cache. Clients do not retry a submission a day later. The app also prunes at `ORACLE_IDEMPOTENCY_RETENTION_SEC` (default 1h). |
| `oracle_nonces` | `oracle_submissions` rows with a nonce | operational | 10 minutes | Replay-protection window only (`ORACLE_NONCE_RETENTION_SEC`). Enforced by the backend on request traffic. |
| `oracle_submissions_rejected` | `oracle_submissions` WHERE `status = 'rejected'` and no dispute | operational | 180 days | A rejected submission that was never challenged has no audit weight after ~two quarters. |
| `oracle_resolution_lag` | `oracle_resolution_lag` | operational | 400 days | Historical aggregator performance for dashboards; older observations are outside the reporting window. |
| `oracle_submissions_finalized` | `oracle_submissions` WHERE `status = 'finalized'` | **audit** | 7 years | The record of how a market resolved. |
| `council_votes` | `council_votes` | **audit** | 7 years | Which council member voted which outcome — primary dispute evidence. |
| `oracle_disputes` | `oracle_disputes` | **audit** | 7 years | The dispute record itself; bounded by the longest plausible dispute/appeal window. |
| `adapter_raw_payloads` | `adapter_raw_payloads` | **audit** | 7 years | The provider responses a resolution was based on. Primary evidence when a resolution is disputed — without it there is no record of what the provider actually returned at decision time. Bounded per row at 1 MiB (see below). |
| `markets`, `bets`, `leaderboard` | derived state | operational (reconstructible) | Indefinite while live | Product-critical and reconstructible from chain within the RPC window. See `docs/DEPLOYMENT-GUIDE.md` disaster recovery (#648). |

> **7 years** is a placeholder for a legal/compliance decision, not a derived
> number. Change it in `0018_data_retention.sql`, `data_retention_policies`, and
> `COUNCIL_AUDIT_RETENTION` (`oracle/src/aggregator/council-audit.ts`) together.

### Raw provider payloads — bounded storage

`adapter_raw_payloads` (migration `0028_adapter_raw_payloads`) is the one
audit-class table that grows with provider response size rather than with a
fixed row count, so it carries an explicit per-row bound:

| Concern | Position |
|---|---|
| Row size | Capped at **1 MiB** (`max_raw_payload_bytes()`), enforced by a CHECK constraint. A payload over the cap is stored shortened with a 2 KB preview and `truncated = true`, so an oversized provider response cannot fill the disk through the audit path. |
| Compression | `raw_response` is JSONB, which Postgres TOASTs and pglz-compresses past ~2 KB — exactly the large-payload case. Compressing by hand would make the column opaque to SQL inspection and to the audit tooling that reads it. `response_bytes` stores the *uncompressed* size so growth stays observable. |
| Credentials | Redacted before storage by `sanitizeProvenanceValue` (`oracle/src/adapters/provenance.ts`): api keys, tokens and `Authorization` headers. |
| Write mode | Append-only, one row per provider per fetch. Never overwritten — re-fetching must not destroy the observation that was in hand at decision time. |

Change the cap in the migration and in `MAX_RAW_PAYLOAD_BYTES`
(`oracle/src/aggregator/council-audit.ts`) together; the writer shortens the
payload *and* the schema rejects it, so the two must agree.

Exported by the council audit tooling in three forms: `json` (payloads inline),
`raw-csv` (one row per payload, payloads inline), and `csv` (per-market
summary only — providers and a count — so the one-row-per-market export stays
usable).

## Enforcement

### Operational — automatic

A single SQL entry point applies every operational policy in bounded batches:

```sql
SELECT * FROM enforce_data_retention();
--        category           | rows_removed
-- --------------------------+-------------
--  events_hot               |        1240
--  events_archive           |           0
--  dead_letter_events       |          17
--  idempotency_keys         |         903
--  oracle_submissions_rejected |        4
-- oracle_resolution_lag       |        0
```

Run it daily from cron on the DB host (see `infra/README.md` § "Data
retention"):

```cron
30 3 * * * psql "$DATABASE_URL" -c "SELECT * FROM enforce_data_retention();" >> /var/log/ipredict-retention.log 2>&1
```

Each function is also callable individually with custom parameters
(`purge_dead_letter_events(retention_days, batch_size)`,
`purge_oracle_resolution_lag(retention_days, batch_size)`, etc.) and is safe to
run repeatedly — call until `rows_removed` is `0` to drain a large backlog
without a long-held lock. The indexer exposes `purgeDeadLetterEvents()`
(`indexer/src/deadLetter.ts`) for the same purpose in-process.

### Audit — manual

`enforce_data_retention()` deliberately excludes the three audit categories.
Deleting audit data is a reviewed operation:

1. Confirm no open dispute, appeal, or legal hold references the market(s).
2. `isCouncilAuditRecordPurgeable(finalizedAt)` (`oracle/src/aggregator/council-audit.ts`) gates eligibility on the retention window.
3. Export the records first (`npm run audit:export` → CSV/JSON) to cold storage.
4. Delete within a single transaction, recorded in the change log.

## Verification

- `SELECT max(created_at) FROM dead_letter_events;` should stay within 90 days.
- `SELECT count(*) FROM events;` should track the 30-day archival window, not grow monotonically.
- The retention cron log should show a run every day.
- Alert if `enforce_data_retention()` has not run in 48h (see `infra/README.md`).
