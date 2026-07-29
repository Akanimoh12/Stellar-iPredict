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

## Notes

- This runbook is an alternative if automated integration testing cannot reach the required Soroban/testnet endpoints.
- If the database schema is not yet updated, apply `db/migrate.ts` first.
