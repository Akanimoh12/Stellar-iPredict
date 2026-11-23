# Aggregator Module Documentation

> **Status:** Design document for the future oracle aggregator system (Phase 2).  
> **Purpose:** Document the composition and flow of aggregator modules to unblock implementation.  
> **Target audience:** Contributors implementing the `processMarket` function and related oracle logic.

---

## Table of Contents

1. [Overview](#overview)
2. [Module Architecture](#module-architecture)
3. [Exports by Pipeline Stage](#exports-by-pipeline-stage)
4. [Data Flow Diagram](#data-flow-diagram)
5. [Implementation Guide](#implementation-guide)
6. [Example: Implementing processMarket](#example-implementing-processmarket)

---

## Overview

The aggregator is the orchestration layer for oracle resolution. It monitors expired markets, queries data sources, coordinates provider submissions, handles challenges, and finalizes outcomes.

### Core Responsibilities

| Responsibility | Module | Description |
|----------------|--------|-------------|
| **Detection** | `poller` | Find expired markets that need resolution |
| **Data Acquisition** | `dataProviders/*` | Query external APIs for real-world outcomes |
| **Consensus** | `consensus` | Aggregate multiple data sources into a single outcome |
| **Submission** | `submitter` | Submit outcomes to the smart contract with bonds |
| **Monitoring** | `challenger` | Watch for challenges during the dispute window |
| **Finalization** | `finalizer` | Resolve markets after successful challenge windows |
| **Council Coordination** | `councilResolver` | Handle disputed outcomes via council vote |

---

## Module Architecture

The aggregator follows a **pipeline architecture** where each module performs one stage and passes data to the next:

```
┌──────────────────────────────────────────────────────────────────┐
│                       Aggregator Index                           │
│  (oracle/src/aggregator/index.ts)                                │
│  - Exports all modules                                           │
│  - Provides entry point: startAggregator()                       │
└──────────────────────────────────────────────────────────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
    ┌────▼────┐             ┌────▼────┐             ┌────▼────┐
    │ Poller  │             │ Submitter│            │Finalizer│
    │ Module  │             │  Module  │            │ Module  │
    └────┬────┘             └────┬────┘            └────┬────┘
         │                        │                      │
    ┌────▼──────────────────┐    │                      │
    │ Data Providers        │◄───┘                      │
    │ - crypto.ts           │                           │
    │ - sports.ts           │                           │
    │ - politics.ts         │                           │
    └────┬──────────────────┘                           │
         │                                               │
    ┌────▼────────┐                                     │
    │  Consensus  │                                     │
    │   Module    │─────────────────────────────────────┘
    └─────────────┘
```

### Directory Structure

```
oracle/src/aggregator/
├── index.ts                    # Main entry point, exports all modules
├── types.ts                    # Shared TypeScript interfaces
├── config.ts                   # Configuration (time windows, bonds, etc.)
│
├── poller.ts                   # Stage 1: Market detection
├── dataProviders/
│   ├── index.ts                # Provider exports (grouped by domain)
│   ├── crypto.ts               # Crypto price providers (CoinGecko, Binance, CMC)
│   ├── sports.ts               # Sports data providers (SportDataAPI, TheOddsAPI)
│   ├── politics.ts             # Political outcome providers (Metaculus, PolyMarket)
│   └── types.ts                # Provider interface definitions
│
├── consensus.ts                # Stage 2: Multi-source consensus
├── submitter.ts                # Stage 3: On-chain outcome submission
├── challenger.ts               # Stage 4: Challenge detection & handling
├── councilResolver.ts          # Stage 5: Dispute resolution
├── finalizer.ts                # Stage 6: Market finalization
│
└── utils/
    ├── stellar.ts              # Stellar SDK helpers (invoke contract, sign tx)
    ├── retry.ts                # Retry logic for API calls
    └── logger.ts               # Structured logging
```

---

## Exports by Pipeline Stage

### Stage 1: Market Detection (`poller.ts`)

**Purpose:** Find expired markets that haven't been resolved yet.

**Exports:**

```typescript
export interface ExpiredMarket {
  id: number;
  question: string;
  category: "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science";
  endTime: number; // Unix timestamp
  totalYes: bigint;
  totalNo: bigint;
}

/**
 * Poll the market contract for expired unresolved markets.
 * @returns Array of markets ready for oracle resolution
 */
export async function pollExpiredMarkets(): Promise<ExpiredMarket[]>;

/**
 * Check if a specific market is ready for resolution.
 * Used for testing and manual triggers.
 */
export async function isMarketExpired(marketId: number): Promise<boolean>;
```

**Usage in processMarket:**
```typescript
import { pollExpiredMarkets } from './poller';

const expiredMarkets = await pollExpiredMarkets();
for (const market of expiredMarkets) {
  await processMarket(market);
}
```

---

### Stage 2: Data Acquisition (`dataProviders/*`)

**Purpose:** Query external data sources to determine the real-world outcome.

#### Provider Interface (`dataProviders/types.ts`)

```typescript
export interface DataProvider {
  name: string; // "CoinGecko", "Binance", etc.
  category: MarketCategory;
  
  /**
   * Query this provider for the outcome of a market.
   * @returns true (YES), false (NO), or null (cannot determine)
   */
  query(market: ExpiredMarket): Promise<boolean | null>;
}

export interface ProviderResult {
  provider: string;
  outcome: boolean | null;
  confidence: number; // 0.0 to 1.0
  metadata?: any; // Raw data for debugging
}
```

#### Crypto Providers (`dataProviders/crypto.ts`)

```typescript
/**
 * CoinGecko price provider.
 * Queries CoinGecko API for cryptocurrency prices.
 */
export const coinGeckoProvider: DataProvider = {
  name: "CoinGecko",
  category: "Crypto",
  query: async (market) => {
    // Parse market question: "Will BTC reach $150k by Dec 31?"
    const { symbol, threshold } = parseQuestion(market.question);
    const price = await fetchCoinGeckoPrice(symbol);
    return price >= threshold; // true if YES, false if NO
  }
};

/**
 * Binance price provider.
 * Queries Binance API for cryptocurrency prices.
 */
export const binanceProvider: DataProvider;

/**
 * CoinMarketCap price provider.
 */
export const coinMarketCapProvider: DataProvider;

// Convenience function: query all crypto providers
export async function queryCryptoProviders(market: ExpiredMarket): Promise<ProviderResult[]>;
```

#### Sports Providers (`dataProviders/sports.ts`)

```typescript
/**
 * SportDataAPI provider.
 * Queries official sports results.
 */
export const sportDataProvider: DataProvider = {
  name: "SportDataAPI",
  category: "Sports",
  query: async (market) => {
    // Parse: "Will Team X win the match on Nov 23?"
    const { team, opponent, date } = parseQuestion(market.question);
    const result = await fetchMatchResult(team, opponent, date);
    return result.winner === team;
  }
};

/**
 * TheOddsAPI provider.
 * Secondary sports data source.
 */
export const oddsApiProvider: DataProvider;

export async function querySportsProviders(market: ExpiredMarket): Promise<ProviderResult[]>;
```

#### Politics Providers (`dataProviders/politics.ts`)

```typescript
/**
 * Metaculus API provider.
 * Queries prediction market consensus.
 */
export const metaculusProvider: DataProvider;

/**
 * PolyMarket provider.
 * Another prediction market data source.
 */
export const polyMarketProvider: DataProvider;

export async function queryPoliticsProviders(market: ExpiredMarket): Promise<ProviderResult[]>;
```

#### Aggregated Provider Export (`dataProviders/index.ts`)

```typescript
// Grouped by category for easy access
export const providers = {
  Crypto: [coinGeckoProvider, binanceProvider, coinMarketCapProvider],
  Sports: [sportDataProvider, oddsApiProvider],
  Politics: [metaculusProvider, polyMarketProvider],
  // ... other categories
};

/**
 * Query all providers for a given market category.
 * This is the primary entry point for processMarket.
 */
export async function queryProviders(market: ExpiredMarket): Promise<ProviderResult[]> {
  const categoryProviders = providers[market.category];
  if (!categoryProviders) {
    throw new Error(`No providers configured for category: ${market.category}`);
  }
  
  const results = await Promise.allSettled(
    categoryProviders.map(p => p.query(market))
  );
  
  return results.map((result, i) => ({
    provider: categoryProviders[i].name,
    outcome: result.status === 'fulfilled' ? result.value : null,
    confidence: result.status === 'fulfilled' ? 1.0 : 0.0,
  }));
}
```

**Usage in processMarket:**
```typescript
import { queryProviders } from './dataProviders';

const providerResults = await queryProviders(market);
// => [
//   { provider: "CoinGecko", outcome: false, confidence: 1.0 },
//   { provider: "Binance", outcome: false, confidence: 1.0 },
//   { provider: "CoinMarketCap", outcome: false, confidence: 1.0 }
// ]
```

---

### Stage 3: Consensus (`consensus.ts`)

**Purpose:** Aggregate multiple provider results into a single outcome.

**Exports:**

```typescript
export interface ConsensusResult {
  outcome: boolean | null; // Final outcome, or null if no consensus
  confidence: number; // 0.0 to 1.0
  agreement: number; // Fraction of providers that agreed (e.g., 0.67 for 2/3)
  details: {
    yesVotes: number;
    noVotes: number;
    abstains: number;
  };
}

/**
 * Determine consensus from multiple provider results.
 * @param results Array of provider outcomes
 * @param threshold Minimum agreement fraction (default: 0.67 for 2/3)
 * @returns Consensus outcome or null if no agreement
 */
export function determineConsensus(
  results: ProviderResult[],
  threshold: number = 0.67
): ConsensusResult;

/**
 * Weighted consensus (future: weight by provider reputation).
 */
export function weightedConsensus(
  results: ProviderResult[],
  weights: Map<string, number>
): ConsensusResult;
```

**Usage in processMarket:**
```typescript
import { determineConsensus } from './consensus';

const consensus = determineConsensus(providerResults);
if (consensus.outcome === null) {
  logger.warn(`No consensus for market ${market.id}, manual review required`);
  return;
}
// => { outcome: false, confidence: 1.0, agreement: 1.0 }
```

---

### Stage 4: Submission (`submitter.ts`)

**Purpose:** Submit the consensus outcome to the smart contract with a bond.

**Exports:**

```typescript
export interface SubmissionResult {
  success: boolean;
  transactionHash: string;
  bondAmount: bigint;
  submissionTime: number;
  challengeDeadline: number; // submissionTime + challengeWindowHours
}

/**
 * Submit an outcome to the market contract with a bond.
 * @param marketId Market to resolve
 * @param outcome YES (true) or NO (false)
 * @param providerKeypair Oracle provider signing key
 * @returns Submission result with tx hash and challenge deadline
 */
export async function submitOutcome(
  marketId: number,
  outcome: boolean,
  providerKeypair: Keypair
): Promise<SubmissionResult>;

/**
 * Calculate required bond amount for a market.
 * Bonds scale with market size (see ORACLE_SECURITY_CHECKLIST.md).
 */
export function calculateBond(market: ExpiredMarket): bigint;
```

**Usage in processMarket:**
```typescript
import { submitOutcome } from './submitter';

const result = await submitOutcome(market.id, consensus.outcome, providerKeypair);
logger.info(`Submitted market ${market.id}: outcome=${consensus.outcome}, tx=${result.transactionHash}`);
// Challenge window open until: result.challengeDeadline
```

---

### Stage 5: Challenge Monitoring (`challenger.ts`)

**Purpose:** Watch for challenges during the dispute window and handle escalation.

**Exports:**

```typescript
export interface Challenge {
  marketId: number;
  challenger: string; // Public key
  challengedOutcome: boolean; // What the challenger claims is correct
  bondAmount: bigint;
  timestamp: number;
}

/**
 * Check if a market has been challenged.
 * @returns Challenge info if challenged, null otherwise
 */
export async function getChallenge(marketId: number): Promise<Challenge | null>;

/**
 * Monitor a submitted outcome for challenges.
 * Calls callback if a challenge is detected.
 */
export async function monitorForChallenges(
  marketId: number,
  challengeDeadline: number,
  onChallenge: (challenge: Challenge) => Promise<void>
): Promise<void>;

/**
 * Escalate a challenged market to council review.
 */
export async function escalateToCouncil(marketId: number): Promise<void>;
```

**Usage in processMarket:**
```typescript
import { monitorForChallenges, escalateToCouncil } from './challenger';

await monitorForChallenges(market.id, result.challengeDeadline, async (challenge) => {
  logger.warn(`Market ${market.id} challenged by ${challenge.challenger}`);
  await escalateToCouncil(market.id);
});
```

---

### Stage 6: Council Resolution (`councilResolver.ts`)

**Purpose:** Coordinate council voting on disputed outcomes.

**Exports:**

```typescript
export interface CouncilVote {
  councilMember: string;
  outcome: boolean;
  timestamp: number;
}

/**
 * Fetch current council votes for a market.
 */
export async function getCouncilVotes(marketId: number): Promise<CouncilVote[]>;

/**
 * Check if council has reached consensus (e.g., 4/7 votes).
 * @returns Winning outcome if threshold reached, null otherwise
 */
export function checkCouncilConsensus(
  votes: CouncilVote[],
  threshold: number = 4,
  councilSize: number = 7
): boolean | null;

/**
 * Notify council members that a market needs review.
 */
export async function notifyCouncil(marketId: number, challenge: Challenge): Promise<void>;
```

**Usage in processMarket:**
```typescript
import { getCouncilVotes, checkCouncilConsensus } from './councilResolver';

const votes = await getCouncilVotes(market.id);
const outcome = checkCouncilConsensus(votes);
if (outcome !== null) {
  logger.info(`Council reached consensus for market ${market.id}: ${outcome}`);
  await finalizeMarket(market.id, outcome);
}
```

---

### Stage 7: Finalization (`finalizer.ts`)

**Purpose:** Finalize markets after successful challenge windows or council resolution.

**Exports:**

```typescript
export interface FinalizationResult {
  success: boolean;
  transactionHash: string;
  finalOutcome: boolean;
  bondsDistributed: {
    winner: string;
    amount: bigint;
  }[];
}

/**
 * Finalize a market with the given outcome.
 * Called after:
 * - Challenge window passed with no challenges
 * - Council reached consensus on a disputed market
 */
export async function finalizeMarket(
  marketId: number,
  outcome: boolean,
  providerKeypair: Keypair
): Promise<FinalizationResult>;

/**
 * Check if a market is ready for finalization.
 * Returns true if:
 * - Submission exists
 * - Challenge window has passed
 * - No unresolved challenges
 */
export async function isReadyForFinalization(marketId: number): Promise<boolean>;
```

**Usage in processMarket:**
```typescript
import { finalizeMarket, isReadyForFinalization } from './finalizer';

if (await isReadyForFinalization(market.id)) {
  const result = await finalizeMarket(market.id, consensus.outcome, providerKeypair);
  logger.info(`Finalized market ${market.id}: tx=${result.transactionHash}`);
}
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     processMarket(market)                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                 ┌──────────▼──────────┐
                 │   queryProviders    │
                 │  (dataProviders/*)  │
                 └──────────┬──────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
       ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
       │CoinGecko│    │ Binance │    │   CMC   │
       │ $142.5k │    │ $142.6k │    │ $142.4k │
       └────┬────┘    └────┬────┘    └────┬────┘
            │               │               │
            └───────────────┼───────────────┘
                            │
                 ┌──────────▼──────────┐
                 │ determineConsensus  │
                 │   (consensus.ts)    │
                 │  3/3 agree: NO      │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │   submitOutcome     │
                 │   (submitter.ts)    │
                 │  Bond: 100 XLM      │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │ monitorForChallenges│
                 │   (challenger.ts)   │
                 │  Wait 24 hours      │
                 └──────────┬──────────┘
                            │
                    ┌───────┴───────┐
                    │               │
           ┌────────▼────────┐     ┌▼────────────────┐
           │  No Challenge   │     │   Challenged    │
           │                 │     │                 │
           │ finalizeMarket  │     │ escalateToCouncil│
           │  (finalizer.ts) │     │ (councilResolver)│
           └─────────────────┘     └──────┬──────────┘
                                           │
                                   ┌───────▼───────┐
                                   │ Council votes │
                                   │  (4/7 for NO) │
                                   └───────┬───────┘
                                           │
                                   ┌───────▼───────┐
                                   │ finalizeMarket│
                                   │ (finalizer.ts)│
                                   └───────────────┘
```

---

## Implementation Guide

### Step 1: Set Up Module Structure

```bash
mkdir -p oracle/src/aggregator/dataProviders
touch oracle/src/aggregator/{index,types,config,poller,consensus,submitter,challenger,councilResolver,finalizer}.ts
touch oracle/src/aggregator/dataProviders/{index,types,crypto,sports,politics}.ts
```

### Step 2: Implement Core Types (`types.ts`)

```typescript
export interface ExpiredMarket {
  id: number;
  question: string;
  category: "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science";
  endTime: number;
  totalYes: bigint;
  totalNo: bigint;
}

export interface ProviderResult {
  provider: string;
  outcome: boolean | null;
  confidence: number;
  metadata?: any;
}

export interface ConsensusResult {
  outcome: boolean | null;
  confidence: number;
  agreement: number;
  details: { yesVotes: number; noVotes: number; abstains: number };
}

// ... (other interfaces from above)
```

### Step 3: Implement Data Providers First

Start with crypto providers since they're the simplest:

```typescript
// dataProviders/crypto.ts
export const coinGeckoProvider: DataProvider = {
  name: "CoinGecko",
  category: "Crypto",
  async query(market) {
    const { symbol, threshold } = parseQuestion(market.question);
    const price = await fetchCoinGeckoPrice(symbol);
    return price >= threshold;
  }
};

// Helper function
async function fetchCoinGeckoPrice(symbol: string): Promise<number> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`;
  const response = await fetch(url);
  const data = await response.json();
  return data[symbol].usd;
}
```

### Step 4: Implement Consensus Logic

```typescript
// consensus.ts
export function determineConsensus(
  results: ProviderResult[],
  threshold: number = 0.67
): ConsensusResult {
  const valid = results.filter(r => r.outcome !== null);
  const yesVotes = valid.filter(r => r.outcome === true).length;
  const noVotes = valid.filter(r => r.outcome === false).length;
  const abstains = results.length - valid.length;
  
  const total = yesVotes + noVotes;
  const agreement = Math.max(yesVotes, noVotes) / total;
  
  let outcome: boolean | null = null;
  if (yesVotes / total >= threshold) outcome = true;
  else if (noVotes / total >= threshold) outcome = false;
  
  return {
    outcome,
    confidence: agreement,
    agreement,
    details: { yesVotes, noVotes, abstains }
  };
}
```

### Step 5: Implement processMarket (Main Orchestration)

```typescript
// index.ts
import { queryProviders } from './dataProviders';
import { determineConsensus } from './consensus';
import { submitOutcome } from './submitter';
import { monitorForChallenges, escalateToCouncil } from './challenger';
import { finalizeMarket } from './finalizer';

export async function processMarket(
  market: ExpiredMarket,
  providerKeypair: Keypair
): Promise<void> {
  logger.info(`Processing market ${market.id}: "${market.question}"`);
  
  // Step 1: Query data providers
  const providerResults = await queryProviders(market);
  logger.debug(`Provider results:`, providerResults);
  
  // Step 2: Determine consensus
  const consensus = determineConsensus(providerResults);
  if (consensus.outcome === null) {
    logger.warn(`No consensus for market ${market.id}, skipping`);
    return;
  }
  logger.info(`Consensus: ${consensus.outcome} (agreement: ${consensus.agreement})`);
  
  // Step 3: Submit outcome with bond
  const submission = await submitOutcome(market.id, consensus.outcome, providerKeypair);
  logger.info(`Submitted: tx=${submission.transactionHash}, bond=${submission.bondAmount}`);
  
  // Step 4: Monitor for challenges
  await monitorForChallenges(market.id, submission.challengeDeadline, async (challenge) => {
    logger.warn(`Market ${market.id} challenged by ${challenge.challenger}`);
    await escalateToCouncil(market.id);
  });
  
  // Step 5: Finalize if challenge window passed
  const result = await finalizeMarket(market.id, consensus.outcome, providerKeypair);
  logger.info(`Finalized: tx=${result.transactionHash}`);
}
```

---

## Example: Implementing processMarket

Here's a complete example showing how the modules compose:

```typescript
// oracle/src/aggregator/index.ts
import { Keypair } from '@stellar/stellar-sdk';
import { pollExpiredMarkets } from './poller';
import { queryProviders } from './dataProviders';
import { determineConsensus } from './consensus';
import { submitOutcome } from './submitter';
import { monitorForChallenges, escalateToCouncil } from './challenger';
import { finalizeMarket, isReadyForFinalization } from './finalizer';
import { getCouncilVotes, checkCouncilConsensus } from './councilResolver';
import { config } from './config';
import logger from './utils/logger';

/**
 * Main aggregator loop.
 * Runs continuously, polling for expired markets every POLLING_INTERVAL_SECONDS.
 */
export async function startAggregator(providerKeypair: Keypair): Promise<void> {
  logger.info("🚀 Starting aggregator...");
  logger.info(`Network: ${config.network}`);
  logger.info(`Polling interval: ${config.pollingIntervalSeconds}s`);
  
  while (true) {
    try {
      // Find expired markets
      const markets = await pollExpiredMarkets();
      logger.info(`Found ${markets.length} expired markets`);
      
      // Process each market
      for (const market of markets) {
        await processMarket(market, providerKeypair);
      }
      
      // Sleep until next poll
      await sleep(config.pollingIntervalSeconds * 1000);
    } catch (error) {
      logger.error("Aggregator error:", error);
      await sleep(10000); // 10s backoff on error
    }
  }
}

/**
 * Process a single market through the resolution pipeline.
 */
async function processMarket(
  market: ExpiredMarket,
  providerKeypair: Keypair
): Promise<void> {
  logger.info(`📊 Processing market #${market.id}: "${market.question}"`);
  
  try {
    // === STAGE 1: DATA ACQUISITION ===
    logger.debug("Querying data providers...");
    const providerResults = await queryProviders(market);
    logger.debug(`Provider results:`, providerResults);
    
    // === STAGE 2: CONSENSUS ===
    logger.debug("Determining consensus...");
    const consensus = determineConsensus(providerResults);
    
    if (consensus.outcome === null) {
      logger.warn(`⚠️  No consensus for market ${market.id} (agreement: ${consensus.agreement})`);
      logger.warn(`Details: ${consensus.details.yesVotes} YES, ${consensus.details.noVotes} NO, ${consensus.details.abstains} abstain`);
      logger.warn("Manual review required");
      return;
    }
    
    logger.info(`✓ Consensus: ${consensus.outcome ? 'YES' : 'NO'} (${(consensus.agreement * 100).toFixed(0)}% agreement)`);
    
    // === STAGE 3: SUBMISSION ===
    logger.debug("Submitting outcome to contract...");
    const submission = await submitOutcome(market.id, consensus.outcome, providerKeypair);
    logger.info(`✓ Submitted: tx=${submission.transactionHash}`);
    logger.info(`Bond: ${submission.bondAmount.toString()} stroops`);
    logger.info(`Challenge window: ${new Date(submission.challengeDeadline * 1000).toISOString()}`);
    
    // === STAGE 4: CHALLENGE MONITORING ===
    logger.debug("Monitoring for challenges...");
    let challenged = false;
    
    await monitorForChallenges(market.id, submission.challengeDeadline, async (challenge) => {
      challenged = true;
      logger.warn(`⚠️  Market ${market.id} CHALLENGED by ${challenge.challenger}`);
      logger.warn(`Challenged outcome: ${challenge.challengedOutcome ? 'YES' : 'NO'}`);
      logger.warn(`Challenge bond: ${challenge.bondAmount.toString()} stroops`);
      
      // === STAGE 5: COUNCIL ESCALATION ===
      logger.info("Escalating to council...");
      await escalateToCouncil(market.id);
      logger.info("✓ Escalated to council review");
      
      // Wait for council to reach consensus
      const councilOutcome = await waitForCouncilConsensus(market.id);
      logger.info(`✓ Council consensus: ${councilOutcome ? 'YES' : 'NO'}`);
      
      // Finalize with council's decision
      await finalizeMarket(market.id, councilOutcome, providerKeypair);
      logger.info(`✓ Finalized with council decision`);
    });
    
    // === STAGE 6: FINALIZATION (if not challenged) ===
    if (!challenged) {
      if (await isReadyForFinalization(market.id)) {
        logger.debug("Challenge window passed, finalizing...");
        const result = await finalizeMarket(market.id, consensus.outcome, providerKeypair);
        logger.info(`✓ Finalized: tx=${result.transactionHash}`);
        logger.info(`Market ${market.id} resolved: ${consensus.outcome ? 'YES' : 'NO'}`);
      }
    }
    
  } catch (error) {
    logger.error(`Error processing market ${market.id}:`, error);
    throw error;
  }
}

/**
 * Wait for council to reach consensus on a disputed market.
 */
async function waitForCouncilConsensus(marketId: number): Promise<boolean> {
  const deadline = Date.now() / 1000 + config.councilReviewHours * 3600;
  
  while (Date.now() / 1000 < deadline) {
    const votes = await getCouncilVotes(marketId);
    const outcome = checkCouncilConsensus(votes);
    
    if (outcome !== null) {
      return outcome;
    }
    
    // Check every minute
    await sleep(60000);
  }
  
  throw new Error(`Council failed to reach consensus within ${config.councilReviewHours} hours`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Export all modules for direct use
export * from './poller';
export * from './dataProviders';
export * from './consensus';
export * from './submitter';
export * from './challenger';
export * from './councilResolver';
export * from './finalizer';
export * from './types';
export * from './config';
```

---

## Summary: Which Module to Use for Each Task

| Task | Module | Function |
|------|--------|----------|
| Find expired markets | `poller` | `pollExpiredMarkets()` |
| Query crypto prices | `dataProviders/crypto` | `queryCryptoProviders()` |
| Query sports results | `dataProviders/sports` | `querySportsProviders()` |
| Determine consensus | `consensus` | `determineConsensus()` |
| Submit outcome | `submitter` | `submitOutcome()` |
| Check for challenges | `challenger` | `getChallenge()` |
| Escalate to council | `challenger` | `escalateToCouncil()` |
| Get council votes | `councilResolver` | `getCouncilVotes()` |
| Finalize market | `finalizer` | `finalizeMarket()` |

**Entry point for contributors:** Start by implementing `processMarket()` in `oracle/src/aggregator/index.ts` using the composition pattern shown above.

---

**Document Version:** 1.0  
**Last Updated:** 2024-11-24  
**Purpose:** Unblock `processMarket` implementation (Issue #620)
