# Optimistic Oracle Runbook

This runbook documents the end-to-end operational procedures for the iPredict
optimistic oracle: **submit**, **challenge**, and **finalize** operations. It
is the primary reference for operators, on-call engineers, and council members
exercising these flows in testnet or production.

Related reference: [`docs/ORACLE_AND_BACKEND.md`](../../docs/ORACLE_AND_BACKEND.md)  
Security checklist: [`oracle/src/ORACLE_SECURITY_CHECKLIST.md`](./ORACLE_SECURITY_CHECKLIST.md)  
Council finalization flow: [`oracle/src/aggregator/COUNCIL_FLOW_RUNBOOK.md`](./aggregator/COUNCIL_FLOW_RUNBOOK.md)

---

## Contract Constants

These are hard-coded in `contracts/prediction_market/src/lib.rs` and govern
every flow below:

| Constant | Value | Meaning |
|---|---|---|
| `SUBMITTER_BOND` | 100 XLM (`100_0000000` stroops) | Minimum bond a submitter must lock |
| `DISPUTER_BOND` | 200 XLM (`200_0000000` stroops) | Minimum bond a challenger must lock; must also exceed the submitter's bond |
| `CHALLENGE_WINDOW` | 86 400 s (24 h) | Time after submission within which a challenge is accepted |
| `COUNCIL_WINDOW` | 259 200 s (72 h) | Time available for the council to rule on an escalated market |
| `COUNCIL_FEE_BPS` | 1 000 bps (10 %) | Fraction of the loser's bond credited to `AccumulatedFees` |

---

## State Machine

```
OPEN ──► SUBMITTED ──► FINALIZED (unchallenged, after 24 h)
              │
              └──► ESCALATED ──► FINALIZED (council rules, within 72 h)
```

A market enters `SUBMITTED` when anyone calls `submit_outcome`. If nobody
challenges within the 24-hour window, `finalize_outcome` can be called by
anyone to close the market. If a challenger posts a bond within the window, the
state advances to `ESCALATED` and the council has 72 hours to rule via
`resolve_challenge`.

There is no `CHALLENGED` state observable on-chain — the contract goes straight
from `SUBMITTED` to `ESCALATED` when a challenge is accepted. The off-chain
indexer sees two events in the same transaction: `oracle/challenged` followed
by `oracle/escalated`.

---

## Prerequisites

The following environment variables are required by all operations. Export them
before running any command:

```bash
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
export NETWORK_PASSPHRASE="Test SDF Network ; September 2022"
export MARKET_CONTRACT_ID="C..."          # deployed contract address
export ORACLE_SECRET_KEY="SB..."          # submitter/resolver account secret key
export DATABASE_URL="postgres://user:password@localhost:5432/ipredict"
export MARKET_ID="123"                    # target market ID (u64)
```

For production, also set:

```bash
export SOROBAN_RPC_URL="https://mainnet.sorobanrpc.com"
export NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
```

Optional:

```bash
export FINALIZE_WEBHOOK_URL="https://..."  # POST notification after finalization
export LOG_LEVEL="info"                    # debug | info | warn | error
export DRY_RUN="true"                      # validate without sending on-chain
```

---

## Part 1 — Submit Operation

### When to submit

Submit an outcome after a market has expired (`end_time < now`) and is still
unresolved and not cancelled. Only one submission per market is accepted by the
contract — a second `submit_outcome` call returns error code `21`
(`SubmissionAlreadyExists`).

### Pre-submit checklist

1. Confirm the market is expired:
   ```bash
   npm --prefix oracle run submit -- --dry-run --market-id "$MARKET_ID"
   ```
   The dry-run prints the resolved outcome and confidence level without sending
   anything on-chain.

2. Confirm there is no existing submission:
   ```sql
   SELECT market_id, status, submitter, outcome, submitted_at
     FROM oracle_submissions
    WHERE market_id = $MARKET_ID;
   ```
   If a row exists with `status = 'submitted'`, skip to Part 3 (finalization).

3. Confirm the submitter account has at least 100 XLM available.

### Submitting an outcome

```bash
# Live submission
npm --prefix oracle run submit -- --market-id "$MARKET_ID"
```

The `submit-cli` script reads data adapters in priority order
(primary → secondary → tertiary as defined in `docs/ORACLE_AND_BACKEND.md`),
requires a minimum confidence of 0.8 from at least one adapter, and calls
`submit_outcome(submitter, market_id, outcome, bond)` on-chain.

It is idempotent: `OffChainSubmitterService.processMarket` checks
`isAlreadySubmitted` from durable state before touching the chain, so a
restart or duplicate invocation never double-submits.

### What happens on-chain

The contract:
1. Validates the market is expired, unresolved, and not cancelled.
2. Asserts there is no prior submission (error `21` if one exists).
3. Escrows the bond in the contract's internal ledger.
4. Records the submission in state `Submitted`.
5. Sets `challenge_deadline = submitted_at + CHALLENGE_WINDOW`.
6. Emits event `["oracle", "submitted"]` with fields:
   `market_id`, `submitter`, `outcome`, `bond`, `submitted_at`, `challenge_deadline`.

### Expected output

```
{"timestamp":"...","level":"info","message":"submit_outcome submitted",
 "marketId":"123","outcome":true,"bond":1000000000,"txHash":"abc...","adapterName":"binance"}
```

### Error codes

| Code | Name | Meaning |
|---|---|---|
| 21 | `SubmissionAlreadyExists` | `submit_outcome` called twice for the same market |
| 28 | `BondTooSmall` | Bond posted is below `SUBMITTER_BOND` |
| — | Market not expired | `end_time` is still in the future |
| — | Market cancelled | Market was cancelled before submission |

---

## Part 2 — Challenge Operation

### When to challenge

Challenge if the submitted outcome appears incorrect. A challenge must be filed
**within 24 hours** of the submission (before `challenge_deadline`). Challenging
after the window returns error code `26` (`ChallengeWindowClosed`).

A challenger asserts the opposite outcome automatically — the contract derives
the challenger's claimed outcome as `!submission.outcome`.

### Pre-challenge checklist

1. Confirm the submission exists and the window is open:
   ```sql
   SELECT market_id, outcome, submitted_at, challenge_deadline, status
     FROM oracle_submissions
    WHERE market_id = $MARKET_ID;
   ```
   `status` must be `'submitted'` and `now() < challenge_deadline`.

2. Confirm the challenger account has at least 200 XLM (and strictly more than
   the submitter's bond).

3. Review the submission's outcome against your data source before locking funds.

### Calling `challenge` directly

The oracle CLI does not expose a challenge command — this is an intentional
security boundary. Disputes are submitted by council members or authorised
challengers using the Stellar SDK directly:

```typescript
import { Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, Networks } from "@stellar/stellar-sdk";

const server = new rpc.Server(process.env.SOROBAN_RPC_URL!);
const keypair = Keypair.fromSecret(process.env.CHALLENGER_SECRET_KEY!);
const contract = new Contract(process.env.MARKET_CONTRACT_ID!);

const sourceAccount = await server.getAccount(keypair.publicKey());
const challengerBond = 200_0000000n; // 200 XLM in stroops

const tx = new TransactionBuilder(sourceAccount, {
  fee: "100000",
  networkPassphrase: process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET,
})
  .addOperation(
    contract.call(
      "challenge",
      new Address(keypair.publicKey()).toScVal(),
      nativeToScVal(BigInt(process.env.MARKET_ID!), { type: "u64" }),
      nativeToScVal(challengerBond, { type: "i128" }),
    ),
  )
  .setTimeout(300)
  .build();

const prepared = await server.prepareTransaction(tx);
prepared.sign(keypair);
const result = await server.sendTransaction(prepared);
console.log("challenge tx hash:", result.hash);
```

### What happens on-chain

The contract:
1. Asserts the submission is in state `Submitted` (error `23` if already escalated).
2. Asserts `now < challenge_deadline` (error `26` if window closed).
3. Asserts the challenger's bond strictly exceeds the submitter's bond and meets
   `DISPUTER_BOND` (error `28` if too small).
4. Escrows the challenger's bond.
5. Advances the state to `Escalated`.
6. Sets `council_deadline = now + COUNCIL_WINDOW`.
7. Emits **two events** in the same transaction:
   - `["oracle", "challenged"]` — records both parties and their bonds.
   - `["oracle", "escalated"]` — records the combined state and `council_deadline`.

> **Indexer note:** `challenge` always emits `challenged` then `escalated` in a
> single transaction. The `Challenged` state is never directly observable
> on-chain; index handlers should treat `escalated` as the durable state.

### Error codes

| Code | Name | Meaning |
|---|---|---|
| 22 | `SubmissionNotFound` | No submission exists for this market |
| 23 | `AlreadyChallenged` | Market is already in `Escalated` state |
| 26 | `ChallengeWindowClosed` | The 24-hour window has elapsed |
| 28 | `BondTooSmall` | Challenger bond ≤ submitter bond or < `DISPUTER_BOND` |

---

## Part 3 — Finalize Operation

There are two finalization paths depending on whether the submission was
challenged.

---

### Path A: Unchallenged finalization (after 24 h)

Anyone can call `finalize_outcome` once `now >= challenge_deadline` and no
challenge has been filed.

**Using the CLI:**

```bash
# Dry run first — validate without writing
npm --prefix oracle run submit -- --market-id "$MARKET_ID" --finalize --dry-run

# Live finalization
npm --prefix oracle run submit -- --market-id "$MARKET_ID" --finalize
```

Or using the aggregator, which polls for expired unresolved markets
automatically and calls the finalization flow:

```bash
npm --prefix oracle start
```

**Using the SDK directly:**

```typescript
const tx = new TransactionBuilder(sourceAccount, { fee: "100000", networkPassphrase })
  .addOperation(
    contract.call(
      "finalize_outcome",
      nativeToScVal(BigInt(process.env.MARKET_ID!), { type: "u64" }),
    ),
  )
  .setTimeout(300)
  .build();
```

**What happens on-chain:**

1. Asserts `now >= challenge_deadline` (error `24`: `ChallengeWindowNotElapsed`).
2. Returns the submitter's bond in full (no fee on unchallenged finalization).
3. Resolves the market with `outcome = submission.outcome`.
4. Emits `["oracle", "finalized"]` with `challenged: false`.
   All payout/fee fields except `submitter_payout` (= returned bond) are zero.

---

### Path B: Council ruling after challenge (within 72 h)

Once a market is in `Escalated` state, the admin or a registered resolver (the
council) calls `resolve_challenge` to rule on the outcome.

**The aggregator handles this automatically** when a quorum of council votes is
reached via `CouncilVoteManager` and `computeTally`. The aggregator polls every
`POLL_INTERVAL_MS` milliseconds and calls `finalizeMarketDecision` once
`COUNCIL_THRESHOLD` votes agree.

**Manual override** (use only if the aggregator is unavailable):

```typescript
const tx = new TransactionBuilder(sourceAccount, { fee: "100000", networkPassphrase })
  .addOperation(
    contract.call(
      "resolve_challenge",
      new Address(resolverPublicKey).toScVal(),           // council/admin address
      nativeToScVal(BigInt(process.env.MARKET_ID!), { type: "u64" }),
      nativeToScVal(true /* or false */, { type: "bool" }), // ruling
    ),
  )
  .setTimeout(300)
  .build();
```

**Bond settlement on a council ruling:**

| Ruling | Winner receives | Credited to `AccumulatedFees` |
|---|---|---|
| Submitter correct | own bond + ½ disputer bond | ½ disputer bond (includes 10% council fee) |
| Disputer correct | both bonds less 10% fee | 10% council fee on the submitter bond |

**What happens on-chain:**

1. Asserts the market is in `Escalated` state (error `27`: `InvalidStateTransition`).
2. Distributes bonds per the table above.
3. Resolves the market with the ruling outcome.
4. Emits `["oracle", "finalized"]` with `challenged: true` and full payout fields.

---

### Idempotency guarantee

`finalizeMarketDecision` is protected by two layers:

1. **DB uniqueness constraint** on `oracle_submissions(market_id)` — a second
   `persistFinalDecision` call for the same market throws `MarketAlreadyFinalizedError`
   and never writes.
2. **In-process `FinalizationGuard`** (`finalize-once.ts`) — closes the race
   between concurrent aggregator loop iterations in the same process instance.

A process crash after on-chain confirmation but before the DB write means the
submission is confirmed on-chain but not in the DB. On restart the aggregator
re-checks `isAlreadyResolved` against on-chain state, discovers the market is
resolved, skips finalization, and the DB row is written via re-scan. This means
**the same market can never be paid out twice**.

---

## Part 4 — Monitoring

### Alerts

| Alert | Condition | Responsible component |
|---|---|---|
| `MarketStuck` | Market unresolved > 6 h past expiry | `stuck-market.ts` |
| `BondBelowMinimum` | `bond_amount < SUBMITTER_BOND` for a live submission | `bond-monitor.ts` |
| `CouncilInactivity` | No council votes in > 48 h on an escalated market | `council-inactivity-monitor.ts` |
| `ConflictingSubmissions` | Two adapters return opposite outcomes at high confidence | `conflict-detection.ts` |
| `SubmitFailed` | Submission failed after all retries | `submit-with-retry.ts` → alert webhook |

Webhook alerts POST JSON to `FINALIZE_WEBHOOK_URL` (if configured). A webhook
failure is logged and swallowed — it never blocks the aggregator poll loop.

### Key log fields to watch

```
level=error message="submit_outcome failed" marketId="..." attempts=3
level=warn  message="market stuck" marketId="..." hoursPastExpiry=7.2
level=error message="bond below minimum" marketId="..." currentBond=50000000
level=warn  message="council inactivity" marketId="..." hoursWithoutVote=50
```

Set `LOG_LEVEL=debug` to emit a full structured JSON trace of every adapter
call and state check.

### Checking oracle_submissions table

```sql
-- All active submissions (not yet finalized)
SELECT market_id, submitter, outcome, bond_amount, submitted_at,
       status, challenge_deadline
  FROM oracle_submissions
 WHERE status != 'finalized'
 ORDER BY submitted_at DESC;

-- Escalated markets awaiting council ruling
SELECT market_id, submitter, outcome, submitted_at, status
  FROM oracle_submissions
 WHERE status = 'escalated'
 ORDER BY submitted_at ASC;

-- Recent finalizations
SELECT market_id, decision, tx_hash, finalized_at
  FROM oracle_submissions
 WHERE status = 'finalized'
 ORDER BY finalized_at DESC
 LIMIT 20;
```

---

## Part 5 — Double-Submit / Double-Payout Prevention Summary

The acceptance criteria for issue #160 require that no double-submit or
double-payout path exists. This is enforced at four independent layers:

| Layer | Mechanism | Where |
|---|---|---|
| Contract | `SubmissionAlreadyExists` (error 21) — contract rejects a second `submit_outcome` | `contracts/prediction_market/src/lib.rs` |
| Off-chain submitter | `isAlreadySubmitted` check against durable DB state before building the transaction | `submitter/offChainSubmitter.ts` |
| Finalizer | `isAlreadyResolved` check + `FinalizationGuard` in-process set | `aggregator/finalize-once.ts`, `resolveMarket.ts` |
| DB constraint | `UNIQUE(market_id)` on `oracle_submissions` — a duplicate `INSERT` throws `MarketAlreadyFinalizedError` | `aggregator/market-finalizer.ts` |

No single layer failing can cause a double-payout as long as the layers below it
remain intact. The contract layer is the ultimate backstop — it is enforced
on-chain and cannot be bypassed by any off-chain component.

---

## Part 6 — Runbook Scenarios

### Scenario 1: Normal happy path (no challenge)

```
T+0h   Market expires
T+1h   Aggregator detects expired unresolved market
T+1h   Data adapters return consistent outcome (confidence ≥ 0.8)
T+1h   submit_outcome called → oracle/submitted event emitted
T+25h  Challenge window elapsed with no challenger
T+25h  finalize_outcome called by anyone → oracle/finalized emitted (challenged=false)
T+25h  Submitter bond returned in full
       Market resolved on-chain
       oracle_submissions row written with status='finalized'
```

### Scenario 2: Disputed outcome (council rules for submitter)

```
T+0h   Market expires
T+1h   submit_outcome(market=99, outcome=true, bond=100XLM)
T+3h   Challenger posts challenge(market=99, bond=200XLM)
       → oracle/challenged + oracle/escalated emitted
T+3h   Council is notified (council-inactivity-monitor starts timer)
T+20h  4 of 7 council members vote "yes" (submitter correct)
T+20h  Aggregator detects quorum, calls resolve_challenge(resolver, 99, true)
       → oracle/finalized emitted (challenged=true)
       → Submitter receives 100 XLM + 100 XLM (½ of challenger bond)
       → 100 XLM (½ challenger bond, including 10% fee) credited to AccumulatedFees
T+20h  oracle_submissions row written with status='finalized', decision='yes'
```

### Scenario 3: Market cancelled while submission is open

```
T+0h   submit_outcome(market=77, outcome=false, bond=100XLM)
T+5h   Admin calls resolve_market to cancel market 77
       Contract runs bond-return finalizer for any open oracle submission
       Bond is returned to submitter; market remains in its cancelled state
       oracle/finalized event emitted (bonds settled, market NOT resolved)
```

> Indexer handlers: when `finalized.challenged = false` but the market is
> `cancelled`, do not treat the `finalized` event as a resolution. Always
> read on-chain market state rather than assuming the outcome.

### Scenario 4: Aggregator crash after on-chain confirm, before DB write

```
T+1h   submit_outcome confirmed on-chain (tx_hash known)
T+1h   Process crashes before persistFinalDecision executes
T+2h   Aggregator restarts
T+2h   isAlreadyResolved queries on-chain state → market.resolved = true
T+2h   Aggregator skips re-submission and backfills the DB row from event log
```

No double-submission occurs. The bond is not lost — it stays in contract
escrow and is returned when the market is eventually finalized on-chain.

---

## Part 7 — Exporting an Oracle Audit Trail

The oracle submission log (council votes, bond amounts, resolution decisions)
can be exported for compliance review:

```bash
# JSON audit export
npm --prefix oracle run audit:export -- --format json > oracle-audit.json

# CSV audit export
npm --prefix oracle run audit:export -- --format csv > oracle-audit.csv
```

Only markets with `status = 'finalized'` are exported. Vote tallies are
re-derived using `computeTally` (same deduplication rules as the finalizer)
so `yes_votes` / `no_votes` in the export always match the recorded `decision`.

---

## Part 8 — Running Checks Locally

Before opening a PR that touches `oracle/src/`:

```bash
cd oracle

# Install dependencies
npm ci

# Type-check all oracle source files
npm run typecheck

# Run the full test suite (unit tests only, no network required)
npm test

# Run a single test file
npx vitest run test/aggregator.test.ts
```

All tests should pass with no network access. The test suite uses vitest with
mock adapters and in-memory stores — no Soroban RPC or PostgreSQL instance is
required.

---

## See Also

- [`docs/ORACLE_AND_BACKEND.md`](../../docs/ORACLE_AND_BACKEND.md) — architecture, bond constants, event schema, data source priority
- [`oracle/src/ORACLE_SECURITY_CHECKLIST.md`](./ORACLE_SECURITY_CHECKLIST.md) — PR review checklist for any oracle change
- [`oracle/src/aggregator/COUNCIL_FLOW_RUNBOOK.md`](./aggregator/COUNCIL_FLOW_RUNBOOK.md) — council vote flow and audit export
- `oracle/test/` — unit tests for all components referenced in this runbook
