# Test Fixtures Migration Guide

This guide helps migrate existing tests to use the new `@ipredict/test-fixtures` package.

## What Changed

We created a centralized test fixture package to replace scattered, duplicated fixture code across backend, indexer, and oracle packages. This ensures:
- ✅ Consistent test data across all services
- ✅ Reduced code duplication
- ✅ Single source of truth for test addresses
- ✅ Type-safe fixture builders

## Migration Steps

### 1. Install Dependency

The package is already in the workspace, but you need to add it to your package's dependencies:

```json
// backend/package.json, indexer/package.json, oracle/package.json
{
  "devDependencies": {
    "@ipredict/test-fixtures": "workspace:*"
  }
}
```

### 2. Replace Local Fixture Functions

#### Backend Tests

**Before** (`backend/test/markets.test.ts`):
```typescript
function makeMarketRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 1,
    question: "Will Stellar XLM reach $1 in 2026?",
    image_url: "https://example.com/image.png",
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "100.0000000",
    total_no: "50.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "G" + "A".repeat(55),
    bet_count: 5,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
```

**After**:
```typescript
import { makeMarket } from "@ipredict/test-fixtures";

function makeMarketRow(overrides: Partial<MarketRow> = {}): MarketRow {
  // Now uses shared fixture as base, ensuring consistency
  const base = makeMarket(overrides);
  return {
    ...base,
    // MarketRow-specific formatting (if needed)
    end_time: String(base.end_time),
    total_yes: String(base.total_yes),
    total_no: String(base.total_no),
    ...overrides,
  };
}
```

Or use the builder:
```typescript
import { marketBuilder, TEST_ADDRESSES } from "@ipredict/test-fixtures";

const market = marketBuilder()
  .withId(42)
  .active()
  .createdBy(TEST_ADDRESSES.CREATOR)
  .build();
```

#### Indexer Tests

**Before** (`indexer/test/fixtures/decoded-events.ts`):
```typescript
// Manually constructed event objects
const decodedEvents = {
  market_created: {
    name: "market_created",
    contractId: MARKET_CONTRACT_ID,
    ledger: 4723100,
    txHash: "ca...",
    eventIndex: 0,
    topics: ["mkt", "created"],
    data: {
      market_id: 7n,
      question: "Will ADA reach $5?",
      category: "Crypto",
      // ... many more fields
    },
  },
};
```

**After**:
```typescript
import { makeMarketCreatedEvent, CONTRACT_IDS } from "@ipredict/test-fixtures";

const marketCreatedEvent = makeMarketCreatedEvent({
  market_id: 7n,
  category: "Crypto",
  question: "Will ADA reach $5?",
});
```

#### Oracle Tests

**Before** (`oracle/test/binance-adapter.test.ts`):
```typescript
// Custom mock markets in each test
function mockMarket(id: number) {
  return {
    id,
    question: "Test market",
    category: "Crypto",
    // ... incomplete or inconsistent fields
  };
}
```

**After**:
```typescript
import { makeMarket, MARKET_PRESETS } from "@ipredict/test-fixtures";

// Use preset or custom
const market = MARKET_PRESETS.activeCrypto();
// or
const market = makeMarket({ id: 42, category: "Crypto" });
```

### 3. Use Shared Test Addresses

**Before**:
```typescript
const CREATOR = "GDXTYTUAMJQMN7FS5UX2E7KR75VXLUQ36P3ZDJNIAQOSYAMMCIGUNIOA";
const BETTOR = "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE";
```

**After**:
```typescript
import { TEST_ADDRESSES } from "@ipredict/test-fixtures";

const creator = TEST_ADDRESSES.CREATOR;
const bettor = TEST_ADDRESSES.BETTOR;
```

### 4. Use Presets for Common Scenarios

**Before**:
```typescript
const activeMarket = makeMarketRow({
  id: 1,
  category: "Crypto",
  resolved: false,
  cancelled: false,
  end_time: String(Date.now() + 86400000),
});

const resolvedMarket = makeMarketRow({
  id: 2,
  category: "Sports",
  resolved: true,
  outcome: true,
});
```

**After**:
```typescript
import { MARKET_PRESETS } from "@ipredict/test-fixtures";

const activeMarket = MARKET_PRESETS.activeCrypto();
const resolvedMarket = MARKET_PRESETS.resolvedSports();
```

## Complete Examples

### Backend API Test

```typescript
import { describe, expect, it } from "vitest";
import { marketBuilder, betBuilder, TEST_ADDRESSES } from "@ipredict/test-fixtures";
import { createMarketsRoutes } from "../src/api/markets.js";

describe("Markets API", () => {
  it("returns active markets", async () => {
    const market1 = marketBuilder().withId(1).active().build();
    const market2 = marketBuilder().withId(2).resolved(true).build();
    
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [market1] })
    };
    
    // test implementation
  });
});
```

### Indexer Handler Test

```typescript
import { describe, expect, it } from "vitest";
import { makeMarketCreatedEvent, makeBetPlacedEvent } from "@ipredict/test-fixtures";
import { handleMarketCreated } from "../src/handlers/market_created.js";

describe("Market Created Handler", () => {
  it("indexes market creation event", async () => {
    const event = makeMarketCreatedEvent({
      market_id: 7n,
      category: "Sports",
      question: "Will Team A win?",
    });
    
    await handleMarketCreated(event, mockDb);
    
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO markets"),
      expect.arrayContaining([7, "Sports", "Will Team A win?"])
    );
  });
});
```

### Cache Test

```typescript
import { describe, expect, it } from "vitest";
import { marketBuilder, betBuilder } from "@ipredict/test-fixtures";
import { invalidateOnBetPlaced } from "../src/cache/invalidate.js";

describe("Cache Invalidation", () => {
  it("clears related keys when bet is placed", async () => {
    const market = marketBuilder().withId(42).active().build();
    const bet = betBuilder().onMarket(42).forYes().build();
    
    await invalidateOnBetPlaced(market.id);
    
    const cached = await cache.get(`market:${market.id}`);
    expect(cached).toBeNull();
  });
});
```

## File-by-File Checklist

Update these files across packages:

### Backend
- [ ] `backend/test/markets.test.ts` - ✅ **COMPLETED** (already migrated)
- [ ] `backend/test/contract-helpers.test.ts`
- [ ] `backend/test/leaderboard.test.ts`
- [ ] `backend/test/stats.test.ts`
- [ ] `backend/test/e2e.test.ts`
- [ ] `backend/src/cache/invalidate.test.ts`

### Indexer
- [ ] `indexer/test/fixtures/decoded-events.ts`
- [ ] `indexer/test/handlers.test.ts`
- [ ] `indexer/test/replay.test.ts`

### Oracle
- [ ] `oracle/test/binance-adapter.test.ts`
- [ ] `oracle/test/coinmarketcap-adapter.test.ts`
- [ ] Any other adapter tests

## Benefits After Migration

1. **Consistency**: All tests use the same default values
2. **Maintainability**: Change a default once, propagate everywhere
3. **Readability**: `MARKET_PRESETS.activeCrypto()` vs 20 lines of setup
4. **Type Safety**: TypeScript ensures fixtures match domain types
5. **Testing**: Fixtures themselves are tested

## Rollback

If issues arise, the migration is non-breaking:
- Old fixture functions still work
- Migrate incrementally, test-by-test
- No runtime changes, only test code

## Questions?

See:
- `shared/test-fixtures/README.md` - Full API documentation
- `shared/test-fixtures/src/fixtures.test.ts` - Usage examples
- `backend/test/markets.test.ts` - Migrated example
