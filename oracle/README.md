# Oracle Local Development Guide

> **Status:** This guide covers the future oracle system planned for Phase 2.  
> **Current state:** The prediction market uses a trusted admin/resolver model.  
> **Purpose:** Document how to set up, test, and develop the oracle system locally.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Creating Test Market States](#creating-test-market-states)
5. [Running the Aggregator Locally](#running-the-aggregator-locally)
6. [Testing the Full Resolution Flow](#testing-the-full-resolution-flow)
7. [Configurable Time Windows](#configurable-time-windows)
8. [Common Development Scenarios](#common-development-scenarios)
9. [Troubleshooting](#troubleshooting)

---

## Overview

The oracle system consists of:
- **Aggregator Service**: Node.js service that monitors expired markets and coordinates resolution
- **Oracle Providers**: Independent services that query data sources and submit outcomes
- **Challenge Mechanism**: Allows disputes on submitted outcomes (Phase 2)
- **Council Resolution**: Fallback dispute resolution by trusted council (Phase 1.5+)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Aggregator Service                      │
│  - Polls markets every 30s                                  │
│  - Detects expired markets                                  │
│  - Coordinates provider submissions                         │
│  - Monitors challenge period                                │
└──────────┬────────────────────────────┬─────────────────────┘
           │                            │
    ┌──────▼─────────┐          ┌──────▼─────────┐
    │  Provider A    │          │  Provider B    │
    │  (CoinGecko)   │          │  (Binance)     │
    └──────┬─────────┘          └──────┬─────────┘
           │                            │
           └────────────┬───────────────┘
                        │
           ┌────────────▼─────────────┐
           │  Prediction Market       │
           │  Smart Contract          │
           │  (Stellar Testnet)       │
           └──────────────────────────┘
```

---

## Prerequisites

### System Requirements

- **Node.js** ≥ 18.0.0
- **npm** ≥ 9.0.0
- **PostgreSQL** ≥ 14 (for event indexing)
- **Redis** ≥ 7.0 (for caching, optional for local dev)
- **Stellar CLI** (`stellar-cli` or `soroban-cli`)
- **Docker & Docker Compose** (recommended for database setup)

### Accounts & Keys

You'll need:
1. **Funded Testnet Account** (get from https://laboratory.stellar.org/#account-creator)
2. **Oracle Provider Keypair** (generate via `stellar keys generate provider`)
3. **Admin Account** (the account that deployed the contracts)

### Environment Setup

```bash
# Install Stellar CLI
cargo install --locked stellar-cli --features opt

# Verify installation
stellar --version  # Should be ≥ 21.0.0

# Create development directory
mkdir -p oracle-dev && cd oracle-dev
```

---

## Quick Start

### 1. Clone & Install

```bash
# Clone the repository (when oracle code is added)
git clone https://github.com/Akanimoh12/Stellar-iPredict.git
cd Stellar-iPredict/oracle

# Install dependencies
npm install
```

### 2. Configure Environment

```bash
# Copy example environment file
cp .env.example .env.local

# Edit .env.local with your values
nano .env.local
```

**Required Environment Variables:**

```env
# Stellar Network
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Contract Addresses (from your deployment)
MARKET_CONTRACT_ID=CDGNPRYTFDXJLWZE4YDKZXW4IEN2RLPSE4N7VM5HJ7NLPL2QC45GIXI5
LEADERBOARD_CONTRACT_ID=CCWWOQSDSO3XXLCMA6A2HYRUFYVNUJZ2HPAMFQSPOB4JWYIBY2HWVTOB
TOKEN_CONTRACT_ID=CAYL4TKNRMXAX5ZLQGFEZ6XOC2QHTCTN5QC2SB5BEEHLVO6SDU2UBLRH

# Oracle Provider Configuration
PROVIDER_SECRET_KEY=SBNZ... # Your oracle provider secret key
PROVIDER_PUBLIC_KEY=GDHQ... # Your oracle provider public key

# Data Sources (API Keys)
COINGECKO_API_KEY=your_coingecko_api_key_here
BINANCE_API_KEY=your_binance_api_key_here
SPORTDATA_API_KEY=your_sportdata_api_key_here

# Database (for event indexing)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ipredict_dev

# Redis (optional for local dev)
REDIS_URL=redis://localhost:6379

# Time Window Overrides (for testing)
SUBMISSION_WINDOW_HOURS=1    # Default: 24 hours in production
CHALLENGE_WINDOW_HOURS=0.5   # Default: 24 hours in production
COUNCIL_REVIEW_HOURS=1       # Default: 72 hours in production
```

### 3. Start Local Database

```bash
# Using Docker Compose (recommended)
docker-compose up -d postgres redis

# Or manually start PostgreSQL
# (Assumes you have PostgreSQL installed)
createdb ipredict_dev

# Run migrations
npm run db:migrate
```

### 4. Start the Aggregator

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build
npm start
```

**Expected Output:**
```
[Aggregator] Starting on Stellar Testnet
[Aggregator] Market Contract: CDGN...GXI5
[Aggregator] Provider: GDHQ...MSMD
[Aggregator] Polling interval: 30s
[Aggregator] Listening for expired markets...
```

---

## Creating Test Market States

To test the oracle system, you need markets in various states. Use the seed script:

### Seed Script: `db/seed.ts`

```typescript
import { createMarket, placeBet, waitUntil } from './utils';

async function seedOracleTestData() {
  console.log("Seeding oracle test markets...");
  
  // 1. Market that just expired (ready for submission)
  const market1 = await createMarket({
    question: "Will BTC reach $150k by end of 2024?",
    endTime: Date.now() / 1000 - 60, // Expired 1 minute ago
    category: "Crypto"
  });
  await placeBet(market1.id, true, 1000); // YES bet
  await placeBet(market1.id, false, 500); // NO bet
  console.log(`✓ Market ${market1.id}: Expired, awaiting submission`);
  
  // 2. Market with submission (in challenge window)
  const market2 = await createMarket({
    question: "Will ETH reach $10k by end of 2024?",
    endTime: Date.now() / 1000 - 3600, // Expired 1 hour ago
    category: "Crypto"
  });
  await placeBet(market2.id, true, 2000);
  await placeBet(market2.id, false, 1000);
  // Submit outcome (simulate provider submission)
  await submitOutcome(market2.id, true, providerKeypair);
  console.log(`✓ Market ${market2.id}: Submitted (YES), in challenge window`);
  
  // 3. Market with challenge (needs council review)
  const market3 = await createMarket({
    question: "Will SOL reach $500 by end of 2024?",
    endTime: Date.now() / 1000 - 7200, // Expired 2 hours ago
    category: "Crypto"
  });
  await placeBet(market3.id, true, 5000);
  await placeBet(market3.id, false, 3000);
  await submitOutcome(market3.id, true, providerKeypair);
  await challengeOutcome(market3.id, false, disputerKeypair); // Challenge with opposite outcome
  console.log(`✓ Market ${market3.id}: Challenged, needs council review`);
  
  // 4. Market past challenge window (ready to finalize)
  const market4 = await createMarket({
    question: "Will XLM reach $1 by end of 2024?",
    endTime: Date.now() / 1000 - 86400 - 3600, // Expired 25 hours ago (past 24h challenge window)
    category: "Crypto"
  });
  await placeBet(market4.id, true, 1500);
  await placeBet(market4.id, false, 800);
  await submitOutcome(market4.id, false, providerKeypair);
  console.log(`✓ Market ${market4.id}: Past challenge window, ready to finalize`);
  
  // 5. Active market (not yet expired)
  const market5 = await createMarket({
    question: "Will BTC reach $200k by end of 2025?",
    endTime: Date.now() / 1000 + 86400 * 30, // Expires in 30 days
    category: "Crypto"
  });
  await placeBet(market5.id, true, 500);
  console.log(`✓ Market ${market5.id}: Active, not ready for oracle`);
  
  console.log("\n✅ Seeded 5 markets in various oracle states");
}

// Run the seed script
seedOracleTestData();
```

### Running the Seed Script

```bash
# Seed the database with test markets
npm run db:seed

# Or manually via Stellar CLI
stellar contract invoke \
  --id CDGNPRYTFDXJLWZE4YDKZXW4IEN2RLPSE4N7VM5HJ7NLPL2QC45GIXI5 \
  --source admin \
  --network testnet \
  -- create_market \
  --admin GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD \
  --question "Test Market" \
  --image_url "https://example.com/image.png" \
  --duration_secs 3600
```

---

## Running the Aggregator Locally

### Aggregator Service Structure

```
oracle/src/aggregator/
├── index.ts           # Main entry point
├── poller.ts          # Market polling logic
├── submitter.ts       # Outcome submission
├── challenger.ts      # Challenge detection & handling
├── finalizer.ts       # Market finalization after challenge window
├── dataProviders/
│   ├── crypto.ts      # CoinGecko, Binance, CMC
│   ├── sports.ts      # SportDataAPI, TheOddsAPI
│   └── index.ts       # Provider exports
└── config.ts          # Configurable time windows
```

### Starting the Aggregator

```bash
# Terminal 1: Start the aggregator
cd oracle
npm run dev

# Terminal 2: Watch the logs
tail -f logs/aggregator.log

# Terminal 3: Monitor market states
npm run monitor
```

### Expected Workflow

```
[Poller] Checking for expired markets...
[Poller] Found 1 expired market: #42 "Will BTC reach $150k?"
[Submitter] Querying data sources for market #42...
[DataProvider:Crypto] CoinGecko: BTC = $142,500 (outcome = NO)
[DataProvider:Crypto] Binance: BTC = $142,650 (outcome = NO)
[DataProvider:Crypto] CoinMarketCap: BTC = $142,480 (outcome = NO)
[Submitter] Consensus: NO (3/3 sources agree)
[Submitter] Submitting outcome NO with bond 100 XLM...
[Submitter] ✓ Submitted. Transaction: 7a3c...92f1
[Submitter] Challenge window open for 24 hours
[Challenger] Monitoring for challenges on market #42...
(24 hours later, no challenges)
[Finalizer] Market #42 passed challenge window unchallenged
[Finalizer] Finalizing market #42 with outcome NO...
[Finalizer] ✓ Finalized. Transaction: 8d2e...43a9
```

---

## Testing the Full Resolution Flow

### Scenario 1: Happy Path (No Challenges)

```bash
# 1. Create a market that expires immediately
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- create_market \
  --admin $ADMIN_PUBLIC_KEY \
  --question "Test: Will BTC reach $150k?" \
  --image_url "https://example.com/btc.png" \
  --duration_secs 10  # Expires in 10 seconds

# 2. Place some bets
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source bettor1 \
  --network testnet \
  -- place_bet \
  --user $BETTOR1_PUBLIC_KEY \
  --market_id 42 \
  --is_yes true \
  --amount 10000000  # 1 XLM (7 decimals)

# 3. Wait for market to expire
sleep 15

# 4. The aggregator will detect the expired market and:
#    - Query data sources (CoinGecko, Binance, CMC)
#    - Submit outcome if 2+ sources agree
#    - Start 24h challenge window (or 30 minutes if configured for testing)

# 5. Monitor the submission
npm run monitor -- --market-id 42

# Output:
# Market #42: "Test: Will BTC reach $150k?"
# Status: SUBMITTED
# Outcome: NO
# Submitted by: GDHQ...MSMD
# Submission time: 2024-11-24 10:30:00
# Challenge window ends: 2024-11-24 11:00:00 (30 minutes)
# Challenges: 0

# 6. Wait for challenge window to pass
sleep 1800  # 30 minutes (if configured for testing)

# 7. The aggregator will auto-finalize
# Output in aggregator logs:
# [Finalizer] Market #42 passed challenge window unchallenged
# [Finalizer] Calling finalize_market(42)...
# [Finalizer] ✓ Market #42 resolved: NO
```

### Scenario 2: Challenged Outcome (Council Review)

```bash
# 1. Create expired market (same as above)

# 2. Provider A submits outcome = YES
npm run provider:submit -- --market-id 42 --outcome YES

# 3. Provider B challenges with outcome = NO
npm run provider:challenge -- --market-id 42 --outcome NO --bond 200

# 4. Market enters council review state
npm run monitor -- --market-id 42

# Output:
# Market #42: "Test: Will BTC reach $150k?"
# Status: CHALLENGED
# Original submission: YES by GDHQ...MSMD (100 XLM bond)
# Challenge: NO by GA5O...HR2Q (200 XLM bond)
# Council review deadline: 2024-11-24 13:00:00 (1 hour in test config)
# Council votes: 0/7

# 5. Council members vote
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source council_member_1 \
  --network testnet \
  -- vote_on_dispute \
  --market_id 42 \
  --outcome false  # Voting for NO

# (Repeat for 4+ council members to reach 4/7 threshold)

# 6. After 4+ votes for NO:
# [CouncilResolver] Market #42 reached 4/7 votes for NO
# [CouncilResolver] Finalizing with outcome NO...
# [CouncilResolver] ✓ Market resolved: NO
# [CouncilResolver] Slashing: Provider A loses 100 XLM bond
# [CouncilResolver] Rewarding: Provider B receives 300 XLM (100 + 200)
```

---

## Configurable Time Windows

The oracle uses time windows that are configurable for local testing. **Never deploy short windows to production.**

### Configuration File: `oracle/src/aggregator/config.ts`

```typescript
export interface OracleConfig {
  submissionWindowHours: number;  // How long providers have to submit
  challengeWindowHours: number;   // How long to accept challenges
  councilReviewHours: number;     // Max time for council to vote
  pollingIntervalSeconds: number; // How often to check for expired markets
}

// Load from environment with fallbacks
export const config: OracleConfig = {
  submissionWindowHours: parseFloat(process.env.SUBMISSION_WINDOW_HOURS || '24'),
  challengeWindowHours: parseFloat(process.env.CHALLENGE_WINDOW_HOURS || '24'),
  councilReviewHours: parseFloat(process.env.COUNCIL_REVIEW_HOURS || '72'),
  pollingIntervalSeconds: parseInt(process.env.POLLING_INTERVAL_SECONDS || '30'),
};

// Validation: Warn if production config is too short
if (process.env.STELLAR_NETWORK === 'mainnet') {
  if (config.challengeWindowHours < 12) {
    throw new Error("Challenge window must be ≥12 hours on mainnet");
  }
  if (config.councilReviewHours < 48) {
    throw new Error("Council review must be ≥48 hours on mainnet");
  }
}
```

### Testing with Short Windows

```bash
# .env.local for fast local testing
SUBMISSION_WINDOW_HOURS=0.5   # 30 minutes
CHALLENGE_WINDOW_HOURS=0.5    # 30 minutes
COUNCIL_REVIEW_HOURS=1        # 1 hour
POLLING_INTERVAL_SECONDS=10   # Check every 10 seconds

# Start aggregator with test config
npm run dev

# Output:
# [Config] ⚠️  Using SHORT time windows for testing
# [Config] Submission window: 30 minutes
# [Config] Challenge window: 30 minutes
# [Config] Council review: 1 hour
# [Config] Polling interval: 10 seconds
```

### Advancing Time in Tests

For automated tests, mock the current time:

```typescript
// test/aggregator.test.ts
import { advanceTime, resetTime } from './timeHelpers';

describe('Aggregator', () => {
  beforeEach(() => resetTime());

  it('should finalize market after challenge window', async () => {
    const market = await createExpiredMarket();
    await submitOutcome(market.id, true);
    
    // Advance time by 24 hours (or 30 minutes in test config)
    advanceTime(config.challengeWindowHours * 3600);
    
    // Trigger aggregator poll
    await aggregator.poll();
    
    // Verify market finalized
    const finalMarket = await getMarket(market.id);
    expect(finalMarket.resolved).toBe(true);
  });
});
```

---

## Common Development Scenarios

### Scenario A: Testing Multiple Data Sources

```bash
# 1. Configure multiple API keys in .env.local
COINGECKO_API_KEY=your_key
BINANCE_API_KEY=your_key
COINMARKETCAP_API_KEY=your_key

# 2. Create a crypto market
npm run create-market -- \
  --question "Will BTC reach $150k?" \
  --category Crypto \
  --duration 60  # Expires in 1 minute

# 3. Watch the aggregator query all sources
npm run dev

# Output:
# [CoinGecko] BTC current price: $142,500
# [Binance] BTC current price: $142,650
# [CoinMarketCap] BTC current price: $142,480
# [Consensus] 3/3 sources agree: outcome = NO
# [Submitter] Submitting NO with 100 XLM bond...
```

### Scenario B: Simulating Data Source Disagreement

```bash
# Mock data source responses for testing
npm run dev -- --mock-sources

# In mock mode, you can override responses:
curl -X POST http://localhost:3001/mock/coingecko \
  -H "Content-Type: application/json" \
  -d '{"btc_price": 150500}'  # Above threshold

curl -X POST http://localhost:3001/mock/binance \
  -H "Content-Type: application/json" \
  -d '{"btc_price": 142000}'  # Below threshold

# Aggregator output:
# [CoinGecko] BTC = $150,500 (outcome = YES)
# [Binance] BTC = $142,000 (outcome = NO)
# [CoinMarketCap] BTC = $142,480 (outcome = NO)
# [Consensus] 2/3 sources agree: outcome = NO
# [Submitter] Submitting NO with 100 XLM bond...
```

### Scenario C: Testing Council Dispute Resolution

```bash
# 1. Create a market and force a challenge
npm run create-market -- --question "Test dispute" --duration 10
sleep 15

# 2. Submit conflicting outcomes from two providers
npm run provider:submit -- --market-id 43 --outcome YES --provider provider1
npm run provider:challenge -- --market-id 43 --outcome NO --provider provider2 --bond 200

# 3. Simulate council votes
for i in {1..4}; do
  stellar contract invoke \
    --id $MARKET_CONTRACT_ID \
    --source council_member_$i \
    --network testnet \
    -- vote_on_dispute \
    --market_id 43 \
    --outcome false  # Voting NO
done

# 4. Watch the aggregator finalize based on council vote
npm run monitor -- --market-id 43

# Output after 4th vote:
# [CouncilResolver] Market #43 reached threshold (4/7 votes for NO)
# [CouncilResolver] Finalizing with NO...
# [CouncilResolver] ✓ Resolved
```

---

## Troubleshooting

### Issue: Aggregator Not Detecting Expired Markets

**Symptoms:**
```
[Poller] Checking for expired markets...
[Poller] Found 0 expired markets
```

**Diagnosis:**
```bash
# Check if markets actually exist and are expired
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --network testnet \
  -- get_market_count

# Check a specific market's end_time
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --network testnet \
  -- get_market \
  --market_id 42

# Output:
# {
#   "id": 42,
#   "end_time": 1700832000,  # Unix timestamp
#   "resolved": false
# }

# Compare with current time
date +%s  # Should be > end_time
```

**Solutions:**
- Ensure `endTime` in market is in the past: `endTime < Date.now() / 1000`
- Check polling interval: `POLLING_INTERVAL_SECONDS=10` (faster polling)
- Verify aggregator is connected to correct network: `STELLAR_NETWORK=testnet`

---

### Issue: Data Source API Returning 401 Unauthorized

**Symptoms:**
```
[CoinGecko] Error: 401 Unauthorized
[Error] Failed to fetch BTC price from CoinGecko
```

**Solutions:**
```bash
# 1. Check API key is set
echo $COINGECKO_API_KEY

# 2. Test API key manually
curl -H "x-cg-pro-api-key: $COINGECKO_API_KEY" \
  https://pro-api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd

# 3. Use free tier endpoints for testing (no key required)
# Edit oracle/src/aggregator/dataProviders/crypto.ts:
const url = "https://api.coingecko.com/api/v3/simple/price"; // Free tier
```

---

### Issue: Challenge Window Passed But Market Not Finalized

**Symptoms:**
```
[Monitor] Market #42: Submitted 25 hours ago, still not finalized
```

**Diagnosis:**
```bash
# Check aggregator logs for errors
tail -100 logs/aggregator.log | grep "ERROR"

# Manually trigger finalization
stellar contract invoke \
  --id $MARKET_CONTRACT_ID \
  --source provider \
  --network testnet \
  -- finalize_market \
  --market_id 42
```

**Solutions:**
- Ensure aggregator is running: `ps aux | grep aggregator`
- Check if market is in CHALLENGED state (requires council vote first)
- Verify no pending challenges: `npm run monitor -- --market-id 42`

---

### Issue: Insufficient Funds for Bond

**Symptoms:**
```
[Submitter] Error: Insufficient balance to post bond
[Submitter] Required: 100 XLM, Available: 10 XLM
```

**Solutions:**
```bash
# Fund the provider account
# 1. Get friendbot testnet XLM
curl "https://friendbot.stellar.org?addr=$PROVIDER_PUBLIC_KEY"

# 2. Or transfer from admin account
stellar contract invoke \
  --id $XLM_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- transfer \
  --from $ADMIN_PUBLIC_KEY \
  --to $PROVIDER_PUBLIC_KEY \
  --amount 1000000000  # 100 XLM (7 decimals)
```

---

## Running Tests

```bash
# Run all oracle tests
npm test

# Run specific test suite
npm test -- aggregator.test.ts

# Run with coverage
npm run test:coverage

# Run E2E tests (requires running aggregator)
npm run test:e2e
```

**Example Test Output:**
```
 PASS  src/aggregator/__tests__/poller.test.ts
  Poller
    ✓ should detect expired markets (145ms)
    ✓ should ignore active markets (98ms)
    ✓ should handle multiple expired markets (203ms)

 PASS  src/aggregator/__tests__/submitter.test.ts
  Submitter
    ✓ should submit outcome when 2/3 sources agree (312ms)
    ✓ should not submit when sources disagree (187ms)
    ✓ should post correct bond amount (225ms)

 PASS  src/aggregator/__tests__/challenger.test.ts
  Challenger
    ✓ should detect challenges (156ms)
    ✓ should escalate to council (234ms)

Test Suites: 3 passed, 3 total
Tests:       7 passed, 7 total
Time:        3.142s
```

---

## Next Steps

1. **Review the architecture**: Read `docs/ORACLE_AND_BACKEND.md` for the full system design
2. **Review security model**: Read `oracle/ORACLE_SECURITY_CHECKLIST.md` for threat analysis
3. **Set up local environment**: Follow the [Quick Start](#quick-start) guide
4. **Create test markets**: Use the [seed script](#creating-test-market-states)
5. **Run the aggregator**: Follow [Running the Aggregator Locally](#running-the-aggregator-locally)
6. **Test full flow**: Complete [Scenario 1](#scenario-1-happy-path-no-challenges)

For questions or issues, open a GitHub issue or ask in the Stellar Discord (#dev-discussion).

---

**Document Version:** 1.0  
**Last Updated:** 2024-11-24  
**Maintainer:** Oracle Development Team
# iPredict Oracle

The resolution layer that decides market outcomes without trusting a single
admin. Built in phases (see [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#part-1--oracle-architecture)):

| Phase | Model | Contract changes |
|---|---|---|
| **1.5** | 4-of-7 Council multisig + off-chain aggregator | none (uses existing `add_resolver`/`resolve_market`) |
| **2** | Optimistic oracle — bonded submissions, challenge window, dispute council | new contract functions & state |
| **Data** | Off-chain data adapters (CoinGecko, Binance, sports, politics) feeding submitters | none |

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## What lives here

- **`aggregator/`** — off-chain service that watches council submissions and
  fires the final on-chain resolution once threshold is met.
- **`adapters/`** — one module per data source; each returns a normalized
  outcome for a given market.
- **`submitter/`** — signs and submits outcomes/bonds on behalf of an oracle
  provider.
- **`monitor/`** — watches oracle events (submissions, challenges, disputes)
  and alerts on stuck/conflicting markets.

> Note: the *contract-side* oracle changes (optimistic oracle state machine,
> bonds, dispute council) live under [`contracts/`](../contracts) as new Soroban
> code, tracked by issues labelled `area:oracle` + `area:contracts`.

## Layout

```
oracle/
  src/
    aggregator/
    adapters/      coingecko.ts, binance.ts, sports.ts, politics.ts, ...
    submitter/
    monitor/
    config/
    index.ts
  test/
  package.json
  tsconfig.json
  .env.example
```

## Getting started

```bash
cd oracle
cp .env.example .env
npm install
npm run dev
```

### Running the monitor

The monitor is the read-only half of the oracle. It re-runs the checks in
`aggregator/` against Postgres every `MONITOR_INTERVAL_MS` and emits an alert
for anything an operator needs to see — stuck markets, new submissions,
escalated disputes, under-minimum bonds, an inactive council. It never signs or
submits a transaction, so it needs no resolver key.

```bash
npm run dev:monitor          # tsx watch, against your local .env
npm run build && npm run start:monitor
```

Alerts are logged as JSON and, when `ALERT_WEBHOOK_URL` is set, POSTed to it.
Delivery failures are logged rather than thrown: an alerting outage must not
stop the monitoring loop.

In production it runs as its own `oracle-monitor` service from the same image
as the aggregator — see
[`infra/README.md`](../infra/README.md#why-the-oracle-is-two-services).

## Testing & Quality Assurance

### Unit & Integration Tests

```bash
npm test
```

### Mutation Testing

Coverage measures which lines execute, but mutation testing verifies whether assertions actually detect logic and boundary defects in high-value consensus and settlement code.

```bash
npm run test:mutation
```

- **Target Mutation Score:** `>= 90%` for critical modules (`src/aggregator/threshold.ts`, `src/aggregator/bond-reconciliation.ts`).
- **Reports:** Generated at `oracle/reports/mutation-report.md` and `oracle/reports/mutation-report.json`.

## Documentation

- **[Oracle Provider Integration Contract](../docs/ORACLE_AND_BACKEND.md#part-5--oracle-provider-integration-contract)** — integration guide for oracle providers: authentication, canonical signing, error codes, and client example
- **[Webhook Signature Verification](./docs/WEBHOOK_VERIFICATION.md)** — guide for verifying HMAC-SHA256 signatures on outgoing notifications
- **[Stuck Market Runbook](./docs/STUCK_MARKET_RUNBOOK.md)** — on-call procedure for `oracle.monitor.market_stuck`: diagnosis, remediation, authorization and bond consequences
- **[Council Runbook](./docs/COUNCIL_RUNBOOK.md)** — operational guide for council members and aggregator operators
- **[Architecture Overview](../docs/ORACLE_AND_BACKEND.md)** — design document for oracle and backend systems

## Contributing

Pick an open issue labelled `area:oracle`, claim it, branch off
`implementation-drips`, PR back to `implementation-drips`.

### Aggregator image runbook

Build the production aggregator image from the repository root. The
Dockerfile remains under `oracle/src/aggregator/`, but the root build context
is required because the oracle imports the `@ipredict/shared` workspace.

```bash
docker build -f oracle/src/aggregator/Dockerfile -t ipredict-oracle-aggregator:local .
```

The image runs as the non-root `aggregator` user. Its Docker healthcheck calls
`/health/ready` on `HEALTH_PORT` (9103 by default), so a stale poll loop or an
unready DB/RPC dependency marks the container unhealthy; Prometheus metrics
remain on port 9102.

Run the image with the same environment variables documented in
`oracle/.env.example`.

```bash
docker run --rm --env-file .env ipredict-oracle-aggregator:local
```
