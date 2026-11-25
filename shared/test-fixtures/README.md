# @ipredict/test-fixtures

Shared test fixtures for cross-service testing across backend, indexer, and oracle packages.

## Problem

Each package was building its own test fixtures for the same domain objects — markets, bets, oracle submissions. The fixtures drifted apart, leading to:
- Inconsistent test data across services
- Duplicated fixture code
- Maintenance burden when domain models change
- Different default values causing confusion

## Solution

Centralized, type-safe fixture builders derived from shared types, providing:
- ✅ Consistent test data across all services
- ✅ Fluent builder API for complex scenarios
- ✅ Sensible defaults for quick setup
- ✅ Common presets for frequent use cases
- ✅ Single source of truth for test addresses

## Installation

```bash
npm install --save-dev @ipredict/test-fixtures
```

This package is workspace-internal and included in the monorepo.

## Usage

### Simple Fixtures

```typescript
import { makeMarket, makeBet } from '@ipredict/test-fixtures';

// Use defaults
const market = makeMarket();

// Override specific fields
const customMarket = makeMarket({
  id: 42,
  category: 'Sports',
  question: 'Will Team A win?',
  resolved: true,
  outcome: true
});

const bet = makeBet({
  market_id: '42',
  bettor: TEST_ADDRESSES.BETTOR,
  is_yes: true
});
```

### Builder Pattern

```typescript
import { marketBuilder, betBuilder, TEST_ADDRESSES } from '@ipredict/test-fixtures';

const market = marketBuilder()
  .withId(42)
  .withCategory('Crypto')
  .active()
  .withVolume('1000.0000000', '500.0000000')
  .createdBy(TEST_ADDRESSES.CREATOR)
  .build();

const bet = betBuilder()
  .onMarket(42)
  .by(TEST_ADDRESSES.BETTOR)
  .forYes()
  .withAmount('100000000', '97000000')
  .unclaimed()
  .build();
```

### Presets

```typescript
import { MARKET_PRESETS, BET_PRESETS } from '@ipredict/test-fixtures';

// Common scenarios with one line
const market = MARKET_PRESETS.activeCrypto();
const bet = BET_PRESETS.standardYes(market.id);

// Available market presets:
// - activeCrypto()      - Active crypto market with moderate volume
// - resolvedSports()    - Resolved sports market (yes outcome)
// - cancelledPolitics() - Cancelled politics market
// - endedPending()      - Ended but not yet resolved

// Available bet presets:
// - standardYes(marketId)  - 100 XLM bet on yes
// - standardNo(marketId)   - 100 XLM bet on no
// - whaleBet(marketId)     - 10,000 XLM whale bet
// - claimedWin(marketId)   - Already-claimed winning bet
```

### Event Fixtures (Indexer)

```typescript
import {
  makeMarketCreatedEvent,
  makeBetPlacedEvent,
  makeOracleSubmissionEvent,
  CONTRACT_IDS
} from '@ipredict/test-fixtures';

const event = makeMarketCreatedEvent({
  market_id: 7n,
  question: 'Will Bitcoin reach $100k?',
  category: 'Crypto',
  creator: TEST_ADDRESSES.CREATOR
});

const betEvent = makeBetPlacedEvent({
  market_id: 7n,
  user: TEST_ADDRESSES.BETTOR,
  is_yes: true,
  amount: 100000000n,
  net_amount: 97000000n,
  fee: 3000000n
});
```

### Test Addresses

```typescript
import { TEST_ADDRESSES, generateAddress } from '@ipredict/test-fixtures';

// Well-known addresses for test scenarios
const creator = TEST_ADDRESSES.CREATOR;
const bettor = TEST_ADDRESSES.BETTOR;
const oracle = TEST_ADDRESSES.ORACLE_SUBMITTER;

// Generate deterministic addresses for additional users
const alice = generateAddress('alice');
const bob = generateAddress('bob');
```

## Migration Guide

### Backend Tests

**Before:**
```typescript
function makeMarketRow(overrides = {}) {
  return {
    id: 1,
    question: "Will XLM reach $1?",
    category: "Crypto",
    // ... 10+ more fields
    ...overrides,
  };
}
```

**After:**
```typescript
import { makeMarket } from '@ipredict/test-fixtures';

const market = makeMarket({ id: 1 });
// or
const market = marketBuilder().withId(1).active().build();
```

### Indexer Tests

**Before:**
```typescript
// Each test recreated event structure manually
const event = {
  topics: ["mkt", "created"],
  data: {
    market_id: 7n,
    question: "...",
    // ... manual construction
  }
};
```

**After:**
```typescript
import { makeMarketCreatedEvent } from '@ipredict/test-fixtures';

const event = makeMarketCreatedEvent({ market_id: 7n });
```

### Oracle Tests

**Before:**
```typescript
// Custom fixtures in each test file
function mockMarket() { /* ... */ }
```

**After:**
```typescript
import { makeMarket, MARKET_PRESETS } from '@ipredict/test-fixtures';

const market = MARKET_PRESETS.activeCrypto();
```

## API Reference

### Markets

- `makeMarket(options?)` - Create a market with defaults
- `marketBuilder()` - Fluent builder for markets
  - `.withId(id)`, `.withQuestion(q)`, `.withCategory(cat)`
  - `.active()`, `.ended()`, `.resolved(outcome)`, `.cancelled()`
  - `.withVolume(yes, no)`, `.withBetCount(n)`
  - `.build()`
- `MARKET_PRESETS` - Common preset markets

### Bets

- `makeBet(options?)` - Create a bet with defaults
- `betBuilder()` - Fluent builder for bets
  - `.onMarket(id)`, `.by(address)`, `.forYes()`, `.forNo()`
  - `.withAmount(gross, net?)`, `.claimed()`, `.unclaimed()`
  - `.build()`
- `BET_PRESETS` - Common preset bets

### Events

- `makeMarketCreatedEvent(overrides?)`
- `makeMarketResolvedEvent(overrides?)`
- `makeMarketCancelledEvent(overrides?)`
- `makeBetPlacedEvent(overrides?)`
- `makeOracleSubmissionEvent(overrides?)`
- `makeOracleChallengedEvent(overrides?)`
- `makeOracleFinalizedEvent(overrides?)`
- `makeReferralRegisteredEvent(overrides?)`
- `EVENT_FIXTURES` - Object with all event factory functions
- `CONTRACT_IDS` - Standard contract IDs for tests

### Addresses

- `TEST_ADDRESSES` - Well-known test addresses
  - `CREATOR`, `BETTOR`, `BETTOR_2`
  - `ORACLE_SUBMITTER`, `ORACLE_CHALLENGER`
  - `REFERRER`, `REFEREE`, `TOKEN_RECIPIENT`
- `generateAddress(seed)` - Generate deterministic addresses

## Design Principles

1. **Sensible Defaults**: Every fixture works without configuration
2. **Type Safety**: Full TypeScript support with proper types
3. **Flexibility**: Override any field when needed
4. **Composability**: Fixtures work together (events reference markets, etc.)
5. **Consistency**: All services use the same test data
6. **Maintainability**: Update once, propagate everywhere

## Contributing

When adding new domain objects:
1. Create a new file in `src/` (e.g., `src/leaderboard.ts`)
2. Export a `make*` function with defaults
3. Add a builder class with fluent API
4. Create common presets if applicable
5. Add tests in `fixtures.test.ts`
6. Export from `index.ts`

## Testing

```bash
npm test
```

Tests ensure:
- Default values are correct
- Overrides work properly
- Builders produce valid objects
- Generated addresses are valid Stellar addresses
- Cross-package integration works

## Related

- `@ipredict/shared` - Shared types and constants
- `backend/test/` - Backend test suite
- `indexer/test/` - Indexer test suite
- `oracle/test/` - Oracle test suite
