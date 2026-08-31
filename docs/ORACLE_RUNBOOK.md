# Oracle Operations Runbook

> End-to-end operational procedures for the iPredict oracle system — council
> resolution (Phase 1.5) and optimistic oracle (Phase 2).
>
> **Target audience:** operators, on-call engineers, council members.
>
> **Source of truth:** `contracts/prediction_market/src/lib.rs` (constants),  
> `oracle/src/` (off-chain services), `oracle_submissions` / `council_votes`
> tables (DB).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Contract Constants](#contract-constants)
3. [State Machine](#state-machine)
4. [Prerequisites & Environment](#prerequisites--environment)
5. [Phase 1.5 — Council Resolution](#phase-15--council-resolution)
6. [Phase 2 — Optimistic Oracle](#phase-2--optimistic-oracle)
7. [Monitoring & Alerts](#monitoring--alerts)
8. [Troubleshooting](#troubleshooting)
9. [Safety Mechanisms](#safety-mechanisms)
10. [Audit Trail](#audit-trail)
11. [Running Checks Locally](#running-checks-locally)

---

## Architecture Overview

```
                        ┌──────────────────────────┐
                        │    Market expires on-chain │
                        └─────────────┬────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
    ┌─────────▼──────────┐ ┌─────────▼──────────┐ ┌─────────▼──────────┐
    │  Council (1.5)     │ │  Optimistic (2)    │ │  Admin override    │
    │  4-of-7 multisig   │ │  submit + challenge│ │  resolve_market    │
    │  council_votes DB  │ │  bonds on-chain    │ │  emergency use     │
    └─────────┬──────────┘ └─────────┬──────────┘ └─────────┬──────────┘
              │                       │                       │
              └───────────────────────┼───────────────────────┘
                                      │
                        ┌─────────────▼────────────┐
                        │   Aggregator service      │
                        │   polls every 5s          │
                        │   finalizes on-chain      │
                        └─────────────┬────────────┘
                                      │
                        ┌─────────────▼────────────┐
                        │   Soroban RPC → on-chain  │
                        └──────────────────────────┘
```

**Data flow:**

- **Council path:** Council members vote → `council_votes` table → aggregator
  detects quorum → `resolve_market()` on-chain.
- **Optimistic path:** Submitter posts bond → `submit_outcome()` on-chain →
  optional challenge within 24 h → council rules if escalated →
  `finalize_outcome()` or `resolve_challenge()` on-chain.

Both paths converge in the aggregator, which polls for expired unresolved
markets and finalizes them when the required conditions are met.

---

## Contract Constants

Hard-coded in `contracts/prediction_market/src/lib.rs`:

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

- **SUBMITTED:** Anyone posts an outcome + bond via `submit_outcome`.
- **ESCALATED:** A challenger posts a larger bond within 24 h via `challenge`.
  There is no on-chain `CHALLENGED` state — the contract goes straight from
  `Submitted` to `Escalated`.
- **FINALIZED (unchallenged):** No challenge within 24 h; `finalize_outcome`
  called by anyone.
- **FINALIZED (council):** Council rules via `resolve_challenge`; bonds
  distributed per the settlement table below.

### Bond Settlement (Council Ruling)

| Ruling | Winner receives | Credited to `AccumulatedFees` |
|---|---|---|
| Submitter correct | own bond + ½ disputer bond | ½ disputer bond (includes 10% council fee) |
| Disputer correct | both bonds less 10% fee | 10% council fee on the submitter bond |

An unchallenged finalization takes no fee — the bond is returned whole.

---

## Prerequisites & Environment

Export these before running any oracle command:

```bash
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
export NETWORK_PASSPHRASE="Test SDF Network ; September 2022"
export MARKET_CONTRACT_ID="C..."
export ORACLE_SECRET_KEY="SB..."
export DATABASE_URL="postgres://user:password@localhost:5432/ipredict"
export MARKET_ID="123"
```

For production:

```bash
export SOROBAN_RPC_URL="https://mainnet.sorobanrpc.com"
export NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
```

Optional:

```bash
export FINALIZE_WEBHOOK_URL="https://..."
export LOG_LEVEL="info"        # debug | info | warn | error
export DRY_RUN="true"          # validate without sending on-chain
```

---

## Phase 1.5 — Council Resolution

Council members vote on expired market outcomes. When 4-of-7 agree, the
aggregator finalizes on-chain.

### Council Member: Submitting a Vote

#### Method 1: CLI (Recommended)

```bash
cd oracle
npm run submit -- \
  --market-id 42 \
  --outcome yes \
  --member-key "$COUNCIL_MEMBER_SECRET"
```

Options:
- `--market-id <number>` — target market
- `--outcome <yes|no>` — your decision
- `--member-key <secret>` — your council member secret (or set `COUNCIL_MEMBER_SECRET`)
- `--dry-run` — validate without writing

#### Method 2: Direct Database Insert

```sql
INSERT INTO council_votes (market_id, member, outcome)
VALUES ('42', 'GMEMBER1PUBLICKEY...', true)
ON CONFLICT (market_id, member)
DO UPDATE SET outcome = EXCLUDED.outcome, submitted_at = NOW();
```

#### Research Checklist

Before voting, verify the outcome from at least 2 independent sources:

| Category | Primary Source | Secondary Source |
|---|---|---|
| Crypto | CoinGecko API | Binance API |
| Sports | SportDataAPI | TheOddsAPI |
| Politics | Metaculus | PolyMarket |
| Science | Research publication | Expert committee |

### Aggregator: Monitoring & Finalization

Start the aggregator:

```bash
cd oracle
npm start
```

The aggregator polls every `POLL_INTERVAL_MS` (default 5 s), counts council
votes per market, and finalizes via `resolve_market()` once 4-of-7 agree.

Required env vars for the aggregator:

```bash
DATABASE_URL=postgresql://...
SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
COUNCIL_THRESHOLD=4
COUNCIL_SIZE=7
COUNCIL_MEMBERS=G1...,G2...,G3...,G4...,G5...,G6...,G7...
RESOLVER_SECRET_KEY=S...
MIN_REQUIRED_SUBMISSIONS=4
POLL_INTERVAL_MS=5000
```

### Finalization Flow

1. Aggregator queries `council_votes` for each expired unresolved market.
2. `computeTally` de-duplicates votes (latest per member wins).
3. `meetsThreshold` checks if ≥ 4 members agree on the same outcome.
4. `isAlreadyFinalized` guards against double-finalization.
5. Market state is re-checked (`cancelled` / `resolved`) before on-chain call.
6. `resolve_market(resolver, market_id, outcome)` is submitted on-chain.
7. Decision is persisted to `oracle_submissions` via `finalizeMarketDecision`.

---

## Phase 2 — Optimistic Oracle

Anyone can submit an outcome for an expired market. If unchallenged for 24 h,
it auto-finalizes. If challenged, the dispute escalates to the council.

### Part A: Submit Outcome

#### When to Submit

After a market has expired (`end_time < now`), is unresolved, and not
cancelled. Only one submission per market is accepted (error `21` if
duplicate).

#### Pre-Submit Checklist

1. Confirm market is expired and unresolved.
2. Confirm no existing submission:
   ```sql
   SELECT market_id, status, submitter, outcome, submitted_at
     FROM oracle_submissions
    WHERE market_id = $MARKET_ID;
   ```
3. Confirm submitter account has ≥ 100 XLM.

#### Submit via CLI

```bash
# Dry run
npm --prefix oracle run submit -- --dry-run --market-id "$MARKET_ID"

# Live submission
npm --prefix oracle run submit -- --market-id "$MARKET_ID"
```

#### What Happens On-Chain

1. Validates market is expired, unresolved, not cancelled.
2. Rejects duplicate submission (error `21`).
3. Escrows the bond.
4. Sets `challenge_deadline = submitted_at + CHALLENGE_WINDOW`.
5. Emits `["oracle", "submitted"]` with `market_id`, `submitter`, `outcome`,
   `bond`, `submitted_at`, `challenge_deadline`.

#### Error Codes

| Code | Name | Meaning |
|---|---|---|
| 21 | `SubmissionAlreadyExists` | Duplicate submission for same market |
| 28 | `BondTooSmall` | Bond below `SUBMITTER_BOND` |
| — | Market not expired | `end_time` is still in the future |
| — | Market cancelled | Market was cancelled before submission |

---

### Part B: Challenge a Submission

#### When to Challenge

Within 24 h of the submission (before `challenge_deadline`). A challenger
asserts the opposite outcome automatically.

#### Pre-Challenge Checklist

1. Confirm submission exists and window is open:
   ```sql
   SELECT market_id, outcome, submitted_at, challenge_deadline, status
     FROM oracle_submissions
    WHERE market_id = $MARKET_ID;
   ```
   `status` must be `'submitted'` and `now() < challenge_deadline`.
2. Challenger account has ≥ 200 XLM (and strictly more than submitter's bond).
3. Review the submission against your data source before locking funds.

#### Challenge via SDK

The oracle CLI does not expose a challenge command (intentional security
boundary). Use the Stellar SDK directly:

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

#### What Happens On-Chain

1. Asserts submission is in state `Submitted` (error `23` if already escalated).
2. Asserts `now < challenge_deadline` (error `26` if window closed).
3. Asserts challenger bond > submitter bond and ≥ `DISPUTER_BOND` (error `28`).
4. Escrows challenger's bond.
5. Advances state to `Escalated`.
6. Sets `council_deadline = now + COUNCIL_WINDOW`.
7. Emits **two events** in the same tx: `["oracle", "challenged"]` then
   `["oracle", "escalated"]`.

> **Indexer note:** The `Challenged` state is never observable on-chain. Index
> handlers should treat `escalated` as the durable state.

#### Error Codes

| Code | Name | Meaning |
|---|---|---|
| 22 | `SubmissionNotFound` | No submission exists for this market |
| 23 | `AlreadyChallenged` | Market is already in `Escalated` state |
| 26 | `ChallengeWindowClosed` | The 24-hour window has elapsed |
| 28 | `BondTooSmall` | Challenger bond ≤ submitter bond or < `DISPUTER_BOND` |

---

### Part C: Finalize

#### Path A: Unchallenged (after 24 h)

Anyone can call `finalize_outcome` once `now >= challenge_deadline` and no
challenge has been filed.

```bash
# Dry run
npm --prefix oracle run submit -- --market-id "$MARKET_ID" --finalize --dry-run

# Live finalization
npm --prefix oracle run submit -- --market-id "$MARKET_ID" --finalize
```

Or let the aggregator handle it automatically (`npm --prefix oracle start`).

**What happens on-chain:**
1. Asserts `now >= challenge_deadline` (error `24`: `ChallengeWindowNotElapsed`).
2. Returns the submitter's bond in full (no fee).
3. Resolves the market with the submitted outcome.
4. Emits `["oracle", "finalized"]` with `challenged: false`.

#### Path B: Council Ruling (within 72 h)

Once escalated, the admin or registered resolver calls `resolve_challenge`.
The aggregator handles this automatically when `COUNCIL_THRESHOLD` votes agree
via `CouncilVoteManager` and `computeTally`.

**Manual override** (only if aggregator is unavailable):

```typescript
const tx = new TransactionBuilder(sourceAccount, { fee: "100000", networkPassphrase })
  .addOperation(
    contract.call(
      "resolve_challenge",
      new Address(resolverPublicKey).toScVal(),
      nativeToScVal(BigInt(process.env.MARKET_ID!), { type: "u64" }),
      nativeToScVal(true, { type: "bool" }), // ruling
    ),
  )
  .setTimeout(300)
  .build();
```

**What happens on-chain:**
1. Asserts market is in `Escalated` state (error `27`: `InvalidStateTransition`).
2. Distributes bonds per the settlement table.
3. Resolves the market with the ruling outcome.
4. Emits `["oracle", "finalized"]` with `challenged: true` and full payout fields.

---

## Monitoring & Alerts

### Alert Table

| Alert | Condition | Component |
|---|---|---|
| `MarketStuck` | Market unresolved > 6 h past expiry | `stuck-market.ts` |
| `BondBelowMinimum` | Bond < `SUBMITTER_BOND` for a live submission | `bond-monitor.ts` |
| `CouncilInactivity` | No council votes in > 48 h on escalated market | `council-inactivity-monitor.ts` |
| `CouncilWindowExceeded` | Escalated market > 72 h without ruling | `council-inactivity-monitor.ts` |
| `ConflictingSubmissions` | Two adapters return opposite outcomes at high confidence | `conflict-detection.ts` |
| `SubmitFailed` | Submission failed after all retries | `submit-with-retry.ts` |
| `AggregatorDown` | Aggregator process not running | Infrastructure monitor |

Webhook alerts POST JSON to `FINALIZE_WEBHOOK_URL`. A webhook failure is
logged and swallowed — it never blocks the poll loop.

### Key Log Fields

```
level=error message="submit_outcome failed" marketId="..." attempts=3
level=warn  message="market stuck" marketId="..." hoursPastExpiry=7.2
level=error message="bond below minimum" marketId="..." currentBond=50000000
level=warn  message="council inactivity" marketId="..." hoursWithoutVote=50
```

Set `LOG_LEVEL=debug` for full structured JSON trace of every adapter call
and state check.

### Checking the Database

```sql
-- Active submissions (not yet finalized)
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

-- Council vote distribution for a market
SELECT outcome, COUNT(*) as votes, ARRAY_AGG(member) as members
  FROM council_votes
 WHERE market_id = '42'
 GROUP BY outcome;
```

### Prometheus Metrics

```typescript
aggregator_markets_finalized_total       // counter
aggregator_resolution_lag_seconds        // histogram
aggregator_submission_count              // gauge per market
aggregator_conflict_detected_total       // counter
aggregator_errors_total                  // counter by error_type
```

---

## Troubleshooting

### Market Not Finalizing

**Symptoms:** Market expired but unresolved for > 1 hour.

**Diagnosis:**

```bash
# Check council submissions
psql $DATABASE_URL -c "
  SELECT market_id, COUNT(*) as submissions
    FROM council_votes
   WHERE market_id = '42'
   GROUP BY market_id;"

# Check vote distribution
psql $DATABASE_URL -c "
  SELECT outcome, COUNT(*) as votes
    FROM council_votes
   WHERE market_id = '42'
   GROUP BY outcome;"
```

**Resolutions:**
- **< 4 submissions:** Contact inactive council members.
- **Split vote (3-4 or 2-5):** Investigate market ambiguity; may need admin override.
- **Aggregator not running:** `systemctl restart ipredict-aggregator`.
- **DB connection issue:** Check `DATABASE_URL` and network connectivity.

### Incorrect Outcome Finalized

1. **Do not** manually update the database — on-chain state is source of truth.
2. Investigate which council members voted incorrectly.
3. Review audit logs for data source errors.
4. If within dispute window, initiate challenge (Phase 2).
5. Document in post-mortem; consider removing unreliable members.

### Aggregator Crash

```bash
journalctl -u ipredict-aggregator -n 500 --no-pager | grep ERROR
systemctl restart ipredict-aggregator
```

Common causes: DB connection timeout, RPC rate limit, OOM, unhandled exception.

### Council Window Exceeded (Escalated > 72 h)

```sql
SELECT market_id, submitted_at FROM oracle_submissions
 WHERE status = 'escalated'
   AND now() - submitted_at > interval '72 hours';
```

Resolve manually by calling `resolve_market` with a fallback outcome (e.g.,
cancel the market or rule in favor of a specific outcome), then run the
finalizer to persist the decision and settle bonds.

---

## Safety Mechanisms

### Double-Submit / Double-Payout Prevention

| Layer | Mechanism | Location |
|---|---|---|
| Contract | Error `21` (`SubmissionAlreadyExists`) — rejects second `submit_outcome` | `contracts/prediction_market/src/lib.rs` |
| Off-chain submitter | `isAlreadySubmitted` check against DB before building tx | `submitter/offChainSubmitter.ts` |
| Finalizer | `isAlreadyResolved` + `FinalizationGuard` in-process set | `aggregator/finalize-once.ts`, `resolveMarket.ts` |
| DB constraint | `UNIQUE(market_id)` on `oracle_submissions` — duplicate INSERT throws `MarketAlreadyFinalizedError` | `aggregator/market-finalizer.ts` |

### Crash Recovery

If the aggregator crashes after on-chain confirmation but before DB write:

1. On restart, `isAlreadyResolved` queries on-chain state → `market.resolved = true`.
2. Aggregator skips re-submission; DB row is backfilled from event log.
3. The same market can never be paid out twice.

### Idempotency Guarantee

`finalizeMarketDecision` is protected by:
1. DB uniqueness constraint on `oracle_submissions(market_id)`.
2. In-process `FinalizationGuard` (`finalize-once.ts`).

### Cancellation Protection

If a market is cancelled while an oracle submission is open, bond-return
finalizers run so bonds are never stranded in escrow. The `finalized` event
is emitted but the market remains cancelled — indexers should read market
state rather than assuming resolution from the event alone.

---

## Audit Trail

Export the oracle submission log for compliance review:

```bash
# JSON
npm --prefix oracle run audit:export -- --format json > oracle-audit.json

# CSV
npm --prefix oracle run audit:export -- --format csv > oracle-audit.csv
```

Only markets with `status = 'finalized'` are exported. Vote tallies are
re-derived using `computeTally` (same de-duplication rules as the finalizer)
so `yes_votes` / `no_votes` always match the recorded `decision`.

---

## Running Checks Locally

Before opening a PR that touches `oracle/src/`:

```bash
cd oracle

# Install dependencies
npm ci

# Type-check
npm run typecheck

# Full test suite (no network required — uses mock adapters)
npm test

# Single test file
npx vitest run test/aggregator.test.ts
```

---

## Oracle Events Reference

Every state transition publishes a typed event. Topics are
`["oracle", "<action>"]`. Event data is a map keyed by field names.

| Topics | Emitted by | Data fields |
|---|---|---|
| `["oracle", "submitted"]` | `submit_outcome` | `market_id`, `submitter`, `outcome`, `bond`, `submitted_at`, `challenge_deadline` |
| `["oracle", "challenged"]` | `challenge` | `market_id`, `challenger`, `outcome`, `bond`, `submitter`, `submitter_bond`, `challenged_at` |
| `["oracle", "escalated"]` | `challenge` | `market_id`, `submitter`, `challenger`, `outcome`, `total_bond`, `escalated_at`, `council_deadline` |
| `["oracle", "finalized"]` | `finalize_outcome`, `resolve_challenge` | `market_id`, `outcome`, `challenged`, `submitter`, `challenger`, `submitter_payout`, `challenger_payout`, `council_fee`, `protocol_credit`, `finalized_at` |

**Indexer notes:**
- `challenge` emits `challenged` **and** `escalated` in one transaction.
- `finalized.challenged` distinguishes the two paths: `false` = unchallenged
  auto-finalization, `true` = council ruling.
- A `finalized` event normally means the market is resolved, except when the
  market was cancelled or force-resolved — always read on-chain state.

---

## See Also

- [`docs/ORACLE_AND_BACKEND.md`](./ORACLE_AND_BACKEND.md) — full architecture, bond constants, event schema
- [`oracle/src/OPTIMISTIC_ORACLE_RUNBOOK.md`](../oracle/src/OPTIMISTIC_ORACLE_RUNBOOK.md) — optimistic oracle operational detail
- [`oracle/docs/COUNCIL_RUNBOOK.md`](../oracle/docs/COUNCIL_RUNBOOK.md) — council vote flow and audit export
- [`oracle/src/ORACLE_SECURITY_CHECKLIST.md`](../oracle/src/ORACLE_SECURITY_CHECKLIST.md) — PR review checklist for oracle changes
- [`oracle/test/`](../oracle/test/) — unit tests for all oracle components
