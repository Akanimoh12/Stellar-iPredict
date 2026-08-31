# iPredict — Deployment Guide

## Prerequisites

- [Stellar CLI](https://github.com/stellar/stellar-cli) (v25+)
- [Rust](https://rustup.rs/) 1.85+ with `wasm32v1-none` target
- [Node.js](https://nodejs.org/) 18+ with npm
- A funded Stellar testnet account

### Admin Wallet

- **Public Key:** `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD`
- **Secret Key:** Stored in `$ADMIN_SECRET` environment variable — **NEVER commit to repo**

```bash
# Set up admin key (choose one method):

# Method A: Add to Stellar CLI keychain
stellar keys add admin --secret-key
# Paste your secret key when prompted

# Method B: Export as environment variable
export ADMIN_SECRET="S..."
```

### Fund Account on Testnet

```bash
curl "https://friendbot.stellar.org?addr=GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD"
```

---

## Step 1: Build All Contracts

```bash
cd contracts

# Install wasm target if not already installed
rustup target add wasm32v1-none

# Build all 4 contracts
stellar contract build

# Verify WASM output sizes (should all be < 100KB)
ls -la target/wasm32v1-none/release/*.wasm
```

Expected output:
- `prediction_market.wasm`
- `ipredict_token.wasm`
- `referral_registry.wasm`
- `leaderboard.wasm`

---

## Step 2: Deploy Contracts to Testnet

Deploy in the correct dependency order:

### 2a. Deploy IPredictToken (no dependencies)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/ipredict_token.wasm \
  --source admin \
  --network testnet
# → Returns TOKEN_CONTRACT_ID (e.g., CCY4A5P3BNQEKXH5EBXTEUFMTHVF5Q7K4S3LYT24VYAUXTEUDEXA7ME5)
```

### 2b. Deploy Leaderboard (no dependencies)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/leaderboard.wasm \
  --source admin \
  --network testnet
# → Returns LEADERBOARD_CONTRACT_ID (e.g., CAR4GTU62PBSR27XDAZATW2HSSXK5DPZWBC4MCKUEF4VGFSW6YPPHRCX)
```

### 2c. Deploy ReferralRegistry

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/referral_registry.wasm \
  --source admin \
  --network testnet
# → Returns REFERRAL_CONTRACT_ID (e.g., CAOK6BLEFCNGSFQSPRALKWWL7SS36I7CBVCLBUO2DKQ4PEIOQB4C4QCT)
```

### 2d. Deploy PredictionMarket (depends on all 3)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/prediction_market.wasm \
  --source admin \
  --network testnet
# → Returns MARKET_CONTRACT_ID (e.g., CCUYXGDJLBDOYADEG4IYBTSPPAAUPOUS2RSQWW3CS4LKLXGJ67LQWUOY)
```

---

## Step 3: Initialize Contracts

Initialize in the correct order to set up cross-contract links:

### 3a. Initialize IPredictToken

```bash
stellar contract invoke \
  --id $TOKEN_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --name "iPredict Token" \
  --symbol "IPRED" \
  --decimals 7
```

### 3b. Initialize Leaderboard

```bash
stellar contract invoke \
  --id $LEADERBOARD_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --market_contract $MARKET_CONTRACT_ID \
  --referral_contract $REFERRAL_CONTRACT_ID
```

### 3c. Initialize ReferralRegistry

```bash
stellar contract invoke \
  --id $REFERRAL_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --market_contract $MARKET_CONTRACT_ID \
  --token_contract $TOKEN_CONTRACT_ID \
  --leaderboard_contract $LEADERBOARD_CONTRACT_ID
```

### 3d. Initialize PredictionMarket

```bash
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- initialize \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --token_contract $TOKEN_CONTRACT_ID \
  --referral_contract $REFERRAL_CONTRACT_ID \
  --leaderboard_contract $LEADERBOARD_CONTRACT_ID
```

---

## Step 4: Authorize Minters

Both PredictionMarket and ReferralRegistry need to mint IPREDICT tokens:

```bash
# Authorize PredictionMarket as a minter
stellar contract invoke \
  --id $TOKEN_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- set_minter \
  --minter $MARKET_CONTRACT_ID \
  --authorized true

# Authorize ReferralRegistry as a minter
stellar contract invoke \
  --id $TOKEN_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- set_minter \
  --minter $REFERRAL_CONTRACT_ID \
  --authorized true
```

---

## Step 5: Create Seed Markets

Create 4 crypto prediction markets with CoinGecko images:

```bash
# Market 1: Bitcoin
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Bitcoin (BTC) reach \$100,000 by April 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/1/large/bitcoin.png" \
  --duration 7776000  # 90 days

# Market 2: Ethereum
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Ethereum (ETH) surpass \$5,000 before May 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/279/large/ethereum.png" \
  --duration 7776000  # 90 days

# Market 3: Stellar (XLM)
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Stellar (XLM) break above \$1.00 by June 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/100/large/Stellar_symbol_black_RGB.png" \
  --duration 7776000  # 90 days

# Market 4: Solana
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --question "Will Solana (SOL) flip Ethereum in daily transactions by Q3 2026?" \
  --image_url "https://assets.coingecko.com/coins/images/4128/large/solana.png" \
  --duration 7776000  # 90 days
```

---

## Step 6: Deploy Frontend

### 6a. Configure Environment

```bash
cd frontend
cp .env.local.example .env.local
```

Edit `.env.local` with deployed contract IDs (current **mainnet** values):

```env
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

NEXT_PUBLIC_MARKET_CONTRACT_ID=CDGNPRYTFDXJLWZE4YDKZXW4IEN2RLPSE4N7VM5HJ7NLPL2QC45GIXI5
NEXT_PUBLIC_TOKEN_CONTRACT_ID=CAYL4TKNRMXAX5ZLQGFEZ6XOC2QHTCTN5QC2SB5BEEHLVO6SDU2UBLRH
NEXT_PUBLIC_REFERRAL_CONTRACT_ID=CAGJVX6EXMCKKWDJCQFIEJ34CZTHZOGLWJM6KQTGDEXEO723CJZ5773H
NEXT_PUBLIC_LEADERBOARD_CONTRACT_ID=CCWWOQSDSO3XXLCMA6A2HYRUFYVNUJZ2HPAMFQSPOB4JWYIBY2HWVTOB
# Native XLM SAC — MAINNET (differs from testnet's CDLZFC3S...)
NEXT_PUBLIC_XLM_SAC_ID=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA
NEXT_PUBLIC_ADMIN_PUBLIC_KEY=GDZ4VJWNJPLNU3PAWDYX3V5XNATO7X257DPHWRPFXSCCNEUZ7QTXIIUI
```

> **Note:** The native XLM Stellar Asset Contract ID is DIFFERENT on testnet vs
> mainnet (it derives from the network passphrase). Using the wrong one makes
> every bet/claim trap with `Storage, MissingValue`. The frontend now selects
> the correct one automatically based on `NEXT_PUBLIC_NETWORK`.

### 6b. Local Development

```bash
npm install
npm run dev
# → http://localhost:3000
```

### 6c. Run Tests

```bash
npm test
# Should show 137+ passing tests
```

### 6d. Production Build

```bash
npm run build
# Verify all 8 pages generated
```

### 6e. Deploy to Vercel

1. Connect GitHub repository to [Vercel](https://vercel.com)
2. Set **Root Directory** to `frontend`
3. Add all `NEXT_PUBLIC_*` environment variables in Vercel dashboard
4. Deploy — Vercel auto-deploys on push to `main`

---

## Verification Checklist

After deployment, verify each feature end-to-end:

- [ ] Landing page loads with live stats
- [ ] Markets page shows seed markets
- [ ] Market detail page shows odds and betting panel
- [ ] Wallet connects via Freighter / xBull / Albedo
- [ ] Placing a bet succeeds (check transaction on Stellar Expert)
- [ ] Leaderboard shows rankings
- [ ] Profile page shows bet history after placing bets
- [ ] Admin page accessible only by admin wallet
- [ ] Resolving a market works
- [ ] Claiming rewards works (winner gets XLM + points + tokens)
- [ ] Referral registration works
- [ ] Social sharing generates correct URLs

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Contract not found` | Verify contract ID in `.env.local` matches deployed address |
| `Simulation failed` | Check contract is initialized and caller has auth |
| `Insufficient funds` | Fund account via Friendbot |
| `WASM too large` | Ensure `[profile.release]` has `opt-level = "z"` and `lto = true` |
| `Wallet not connecting` | Ensure Freighter is on Testnet network |
| `Build fails` | Run `rustup target add wasm32v1-none` (Stellar CLI v25+ requires this target) |

---

## Incident Response

The above table is for deploy-time hiccups. A **production incident** —
anything that could lock or lose user funds (a stuck market holding stakes, a
bond discrepancy, an unresolvable dispute) — follows the procedure in
[`oracle/docs/COUNCIL_RUNBOOK.md` § "Incident Response"](../oracle/docs/COUNCIL_RUNBOOK.md#incident-response):

- **Severity** — SEV1 (funds at risk/locked), SEV2 (degraded, no confirmed
  fund impact), SEV3 (transient). **Anything touching user funds is SEV1.**
  The aggregator's `oracle.aggregator.submit_failed` webhook carries the
  computed `severity`.
- **Escalation** — on-call operator is the Incident Commander; SEV1 pages the
  IC + Oracle lead + Protocol/Funds owner, and any fund-movement action is
  authorized through the council multisig, not a single key.
- **User communication** — SEV1: first status within 1 hour, hourly updates,
  a resolved post stating plainly whether funds were at risk or lost.
- **Post-incident review** — blameless, within 5 business days of a SEV1/SEV2,
  published, with owner-and-due-date action items tracked as
  `production-readiness` issues; fund-safety fixes get a regression test
  before close.

### Status page & community channels

Incident updates are posted to `<status page URL>` and the community channels
below. Fill these in for your deployment:

| Channel | URL | Used for |
|---|---|---|
| Status page | `<TBD>` | Authoritative incident status |
| Discord / Telegram | `<TBD>` | User Q&A during an incident |
| X / Twitter | `<TBD>` | Broad SEV1 announcements |

---

## Oracle aggregator outage — graceful degradation

Issue #645. If the oracle aggregator stops, markets stop resolving but the rest
of the platform keeps working. The decision below is deliberate: **surface the
delay honestly and keep the platform open**, rather than fail silently or lock
users out.

### Detection

| Signal | Where | Meaning |
|---|---|---|
| `oracle_aggregator_unavailable_seconds` | oracle `/metrics` | Seconds since the last completed poll cycle once past the degraded threshold; `0` while healthy. From `AggregatorMetrics.serializeAvailability()`. |
| `GET /health/live` on the aggregator | oracle health server | `503 { status: "dead" }` once `lastPollCompletedAt` is older than `MAX_POLL_STALE_MS`. |
| `GET /resolution-status` | backend API | Backend-side inference — counts markets past `end_time + RESOLUTION_GRACE_SECONDS` that are still unresolved and not cancelled. `status`: `on_time` \| `delayed` \| `stalled`. Works even if the aggregator process is unreachable. |

`assessAggregatorAvailability()` (`oracle/src/aggregator/metrics.ts`) is the
shared definition of "too stale": degraded after 15 min, alert after 60 min
(both overridable).

### User-facing surface

`GET /api/markets/resolution-status` returns the same `on_time` / `delayed` /
`stalled` status plus `oldestOverdueSeconds` and `delayedMarketIds`. The
frontend shows a banner on affected markets — *"Resolution is delayed. This
market ended <n> ago and is awaiting the oracle."* A user discovering a stalled
resolution themselves is far more damaging to trust than an acknowledged delay.

### Decision: new markets during an outage

**Market creation stays available.** Markets are created on-chain and the
backend neither can nor should gate that. Instead:

- the resolution-delay banner is shown at creation time and on every market
  detail page while `status != on_time`;
- if the outage is `stalled`, the frontend additionally warns before accepting a
  new bet on an already-overdue market.

Rationale: blocking creation pushes users to a worse, unmonitored path (raw
contract calls) and gives no benefit — the honest signal does. Revisit only if
an outage routinely exceeds the RPC event-retention window (see
`docs/DEPLOYMENT-GUIDE.md` disaster-recovery notes), which would make new markets
genuinely unresolvable.

### Alerting

Prometheus (add to `infra/prometheus/`):

```yaml
- alert: OracleAggregatorUnavailable
  expr: oracle_aggregator_unavailable_seconds > 3600
  for: 5m
  labels: { severity: SEV2 }
  annotations:
    summary: "Oracle aggregator has not completed a poll in >1h"
- alert: MarketResolutionStalled
  expr: ipredict_resolution_oldest_overdue_seconds > 43200
  for: 10m
  labels: { severity: SEV2 }
  annotations:
    summary: "Oldest unresolved overdue market >12h — resolution stalled"
```

Escalate as SEV2 (degraded, no confirmed fund impact) unless a stalled market
holds user stakes near a claim deadline, which is SEV1.

---

## Database backups & verification

Issue #647. The database holds all derived state — markets, bets, leaderboard,
oracle submissions, audit records. An unverified backup is an assumption, not a
recovery plan.

### Procedure & schedule

Operational detail lives in [`infra/README.md` § "Backups"](../infra/README.md#backups).
Summary:

| | What | When |
|---|---|---|
| Backup | `infra/scripts/backup.sh` — verified `pg_dump -Fc` + `.sha256`, 7-day retention, synced offsite | 03:15 daily (cron) |
| Verification | `infra/scripts/verify-backup.sh` — restores the newest dump into a throwaway Postgres, checks it, tears it down | 04:15 daily (cron) |

`verify-backup.sh` checks: every core table present; `pg_restore
--exit-on-error` clean (no partial restore); dump `schema_migrations` ≥ repo
up-migration count (catches a stale backup); no orphaned `bets`. It exits
non-zero and POSTs `{"type":"backup.verification_failed","severity":"SEV2"}` to
`$BACKUP_ALERT_WEBHOOK_URL` on failure, and writes Prometheus metrics via
`VERIFY_METRICS_FILE`.

### Recovery objectives

| Objective | Target | Measured by |
|---|---|---|
| **RPO** | ≤ 24h (≈ minutes effective — chain replay covers the gap) | `ipredict_backup_verify_dump_age_seconds` |
| **RTO** | ≤ 1h | `ipredict_backup_verify_restore_seconds` + migrations + restart; confirm each DR drill |

Record the last drill's observed RTO in `infra/README.md` § "Recovery
objectives".

### Alerting

```yaml
- alert: BackupVerificationFailing
  expr: ipredict_backup_verify_success == 0 or time() - ipredict_backup_verify_timestamp_seconds > 172800
  for: 15m
  labels: { severity: SEV2 }
  annotations:
    summary: "DB backup verification failed or has not run in 48h"
```

The webhook alert (`backup.verification_failed`) is the primary signal; the
Prometheus rule catches the case where the cron job itself stopped running.

---

## Disaster recovery — full state reconstruction

Issue #648. Most database state derives from on-chain events and is in principle
rebuildable by replaying from the indexer. This section establishes what
actually is, how long it takes, and where the boundary falls.

### What is reconstructible from chain, and what is not

| State | Table(s) | Reconstructible? | How / why not |
|---|---|---|---|
| Markets | `markets` | ✅ within RPC retention | Replayed from `market_created` / `market_resolved` / `market_cancelled` events by `runBackfill()`. |
| Bets | `bets` | ✅ within RPC retention | Replayed from `bet_placed` events. `bet_count` is recomputed (`npm run backfill:bet-count`). |
| Leaderboard | `leaderboard` | ✅ always (given `events`) | Pure fold over `events` — `npm run rebuild:leaderboard`. Holds no independent state. |
| Raw events | `events` | ✅ within RPC retention only | `getEvents` serves a bounded window. Older ledgers cannot be re-fetched — see boundary below. |
| Oracle submissions | `oracle_submissions` | ⚠️ partial | On-chain `resolve_market` / bond events give outcome + tx, but off-chain workflow fields (`status` transitions, `nonce`, `request_timestamp`, idempotency) are **not** on chain. |
| Council votes | `council_votes` | ❌ not from chain | Phase 1.5 council votes are recorded off-chain before the on-chain finalize. Backup-only. |
| Oracle disputes (workflow) | `oracle_disputes` | ⚠️ partial | Challenge/escalation exist on chain; `council_deadline`, internal status do not. |
| Dead-letter events | `dead_letter_events` | ❌ (and not worth it) | Operational debug data; acceptable to lose. |
| Idempotency keys / nonces | `idempotency_keys` | ❌ (and not worth it) | Short-TTL operational data; loss only re-opens a brief replay window. |
| Token balances cache | `token_balances` | ✅ | Re-derivable from chain / re-fetch. |

**Backup-only state** — `council_votes`, off-chain fields of
`oracle_submissions` and `oracle_disputes` — is exactly the audit-class data
with 7-year retention (`docs/DATA-RETENTION.md`). Losing it means losing the
record of *how* a disputed market was decided. This is why the daily off-host
backup is load-bearing and not merely a convenience.

### The chain-retention boundary

`getEvents` on the Soroban RPC only returns events within the provider's
retention window (commonly ~7 days on public RPC; longer on a dedicated /
archival node). Ledgers older than that **cannot** be replayed from chain at
all. Consequences:

- `events` older than the window → recoverable only from `events` /
  `events_archive` in a backup.
- The `events_archive` retention (400 days, migration `0018`) is deliberately
  set well beyond any RPC window so the archive + a recent backup together
  cover the full history.
- Establish your RPC's actual retention and record it here: `<fill in>`.
  If it is shorter than the backup interval, shorten the backup interval.

`getBackfillCoverage()` (`indexer/src/backfill.ts`) reports the ledger range a
replay can currently reach for a given database.

### Reconstruction procedure (end to end)

Pre-req: a Postgres instance with the schema applied (`db/migrate` or the
`migrate` compose profile) but no data, `SOROBAN_RPC_URL` pointing at an RPC
with the widest available retention, and `MARKET_CONTRACT_ID` set.

1. **Restore the newest verified backup** if one exists (this is the primary
   path — it recovers backup-only state too):
   `infra/scripts/restore.sh -d "$DATABASE_URL" <dump>` then re-run migrations.
   Skip to step 4 if the restore is complete and current.
2. **Backfill events from chain** (fills gaps since the dump, or everything if
   there is no dump):
   `cd indexer && npm run build && node dist/index.js --backfill`
   Repeat until `getBackfillCoverage().latestLedger` reaches the network head.
3. **Recompute derived aggregates:**
   `npm run backfill:bet-count` (bets → `markets.bet_count`), then
   `npm run rebuild:leaderboard` (events → `leaderboard`).
4. **Reconcile oracle/council state** that is not on chain: from the backup if
   available; otherwise from the council audit exports
   (`npm run audit:export` output kept in cold storage) and the
   `oracle-monitor` alert history. Mark any market whose off-chain decision
   record cannot be recovered for manual review before its claim deadline.
5. **Verify:** run `infra/scripts/verify-backup.sh`-style checks against the
   rebuilt DB — table row counts sane, no orphan bets, `schema_migrations`
   current — then bring up the API and indexer (live polling) and confirm
   `/readyz` and `/resolution-status`.

### Measured rebuild time

Fill in from a real drill (see below). Rough shape on testnet-scale data:

| Step | What determines it | Observed |
|---|---|---|
| Restore backup | dump size, `restore_seconds` metric | `<fill in>` |
| Backfill events | ledgers to replay, RPC rate limits (`fetchWithRetry` backs off on 429) | `<fill in>` |
| `backfill:bet-count` | row count in `bets` | `<fill in>` |
| `rebuild:leaderboard` | row count in `events` — `snapshot.durationMs` | `<fill in>` |
| **Total** | | `<fill in>` — must be ≤ RTO (1h) |

### Testing the procedure (non-production)

Run this as a scheduled quarterly drill against staging, and after any change to
the indexer's event handlers or the schema:

```bash
# 1. fresh scratch DB
createdb ipredict_dr_drill
DATABASE_URL=postgres://…/ipredict_dr_drill npm --prefix db run migrate

# 2. reconstruct (no backup — worst case, chain only)
cd indexer
SOROBAN_RPC_URL=$ARCHIVAL_RPC MARKET_CONTRACT_ID=$MAINNET_MARKET_ID \
  DATABASE_URL=postgres://…/ipredict_dr_drill node dist/index.js --backfill
DATABASE_URL=…/ipredict_dr_drill npm run backfill:bet-count
DATABASE_URL=…/ipredict_dr_drill npm run rebuild:leaderboard   # note durationMs

# 3. diff against production (row counts, a sample of markets/bets, leaderboard top 50)
```

Record the date, the observed timings, the RPC retention window hit, and any
state that did not reconstruct. Last drill: `<date>` — result: `<fill in>`.
