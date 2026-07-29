# Council Flow Runbook

This runbook documents how to exercise the council resolution flow manually when a local/testnet contract environment is available.

## Prerequisites

- A PostgreSQL database reachable via `DATABASE_URL`
- A Soroban RPC endpoint reachable via `SOROBAN_RPC_URL`
- A deployed market contract ID in `MARKET_CONTRACT_ID`
- A resolver account secret key in `ORACLE_SECRET_KEY`
- A market ID that is expired, unresolved, and not cancelled in `MARKET_ID`
- `NETWORK_PASSPHRASE` set for the target network (default: testnet)

## Environment variables

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/ipredict"
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
export NETWORK_PASSPHRASE="Test SDF Network ; September 2022"
export MARKET_CONTRACT_ID="C..."
export ORACLE_SECRET_KEY="SB..."
export MARKET_ID="123"
export COUNCIL_THRESHOLD="4"
```

## Manual steps

1. Ensure the market is expired and unresolved.
   - Query the on-chain contract with `get_market(market_id)`.
   - Confirm `resolved == false`, `cancelled == false`, and `end_time < now()`.

2. Seed council votes.
   - Submit at least `COUNCIL_THRESHOLD` distinct council votes for the same outcome.
   - In this repository, the vote collector is simulated by `CouncilVoteManager`.

3. Finalize the market.
   - The aggregator must call `resolve_market(resolver, market_id, outcome)` using the configured resolver key.
   - After the transaction confirms, the final decision should be persisted into `oracle_submissions`.

4. Verify persistence.
   - Query `oracle_submissions` for the market ID.
   - Confirm `market_id`, `decision`, `tx_hash`, `finalized_at`, and `council_votes` are present.

5. Confirm idempotency.
   - Attempt the same finalization again.
   - The system should reject the duplicate and not create a second row.

6. Verify on-chain state.
   - Confirm `get_market(market_id)` returns `resolved == true` and the expected `outcome`.

## Finalize notifications

When a market is finalized, `finalizeMarketDecision` always logs the event and,
if `FINALIZE_WEBHOOK_URL` is configured, POSTs a `market_finalized` payload to it.

- The notification fires **after** `persistFinalDecision` succeeds. That write is
  guarded by `UNIQUE(market_id)` and throws `MarketAlreadyFinalizedError` on a
  duplicate, so no path can announce the same market twice.
- Delivery is best-effort: a webhook failure is logged and swallowed and can
  never roll back or re-trigger the persisted finalization.

To exercise manually:

1. Point a request bin at `FINALIZE_WEBHOOK_URL` (or tail the process logs for a
   `Market <id> finalized` line when no webhook is configured).
2. Finalize a market (steps above) and confirm exactly one `market_finalized`
   payload / log line appears.
3. Re-run finalization for the same market and confirm no second notification.

## Exporting the council audit

Council decisions and their vote tallies can be exported for audit from the
`oracle_submissions` (finalized decisions) and `council_votes` (per-member votes)
tables:

```bash
# JSON (default)
npm --prefix oracle run audit:export -- --format json > audit.json

# CSV
npm --prefix oracle run audit:export -- --format csv > audit.csv
```

- Only markets with `status = 'finalized'` are exported.
- Tallies are re-derived with the same de-duplication rules the finalizer uses
  (`computeTally`), so exported `yes_votes`/`no_votes` match the recorded decision.
- The CSV `votes` column encodes each member as `member=yes|member=no`.

## Notes

- This runbook is an alternative if automated integration testing cannot reach the required Soroban/testnet endpoints.
- If the database schema is not yet updated, apply `db/migrate.ts` first.
