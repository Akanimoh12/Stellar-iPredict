# Event Schema Contract — Contract ↔ Indexer

> **Status:** Documentation for planned implementation.  
> Current state: Contract does not emit events. Direct RPC polling is used.  
> This document defines the contract for when event emission is added (Phase 2).

---

## Purpose

This document defines the event schema contract between the Stellar-iPredict smart contracts and the indexer. It serves as the source of truth for:

1. **Event topics and payloads** — shape and types emitted by contracts
2. **Indexer handlers** — which handler consumes each event
3. **Compatibility rules** — how to evolve events without breaking the indexer
4. **Validation checks** — detecting contract/indexer mismatches

---

## Event Emission Pattern

All events follow the Soroban SDK event structure:

```rust
env.events().publish(
    (topic1, topic2, ...),  // Topics: identifiers for event type
    data                     // Payload: contracttype-serialized data
);
```

**Topic structure convention:**
- `topics[0]`: Contract domain (`"mkt"` for market events, `"bet"` for betting events, etc.)
- `topics[1]`: Event action (`"created"`, `"resolved"`, `"placed"`, `"claimed"`)
- `topics[2+]`: Indexed parameters (e.g., `market_id`, `user`)

---

## Events Catalog

### 1. Market Created

**Contract:** `prediction_market`  
**Entrypoint:** `create_market`  
**Handler:** `indexer/handlers/market.ts → handleMarketCreated()`

```rust
// Contract emission (to be added in Phase 2)
env.events().publish(
    (symbol_short!("mkt"), symbol_short!("created"), market_id),
    MarketCreatedEvent {
        id: u64,
        question: String,
        image_url: String,
        category: Category,
        end_time: u64,
        creator: Address,
    }
);
```

**Indexer schema:**
```typescript
interface MarketCreatedEvent {
  id: number;
  question: string;
  imageUrl: string;
  category: "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science" | "Other";
  endTime: number;  // Unix timestamp
  creator: string;  // Stellar address
}
```

**Side effects:**
- Insert into `markets` table
- Invalidate `markets:all` cache

---

### 2. Bet Placed

**Contract:** `prediction_market`  
**Entrypoint:** `place_bet`  
**Handler:** `indexer/handlers/bet.ts → handleBetPlaced()`

```rust
// Contract emission (to be added)
env.events().publish(
    (symbol_short!("bet"), symbol_short!("placed"), market_id, user.clone()),
    BetPlacedEvent {
        market_id: u64,
        user: Address,
        gross_amount: i128,  // Pre-fee
        net_amount: i128,    // Post-fee (what goes into pool)
        is_yes: bool,
        total_fee: i128,
        referral_paid: bool,
    }
);
```

**Indexer schema:**
```typescript
interface BetPlacedEvent {
  marketId: number;
  user: string;
  grossAmount: string;  // i128 as string to avoid precision loss
  netAmount: string;
  isYes: boolean;
  totalFee: string;
  referralPaid: boolean;
}
```

**Side effects:**
- Upsert `bets` table (sum `net_amount` if repeat bet)
- Update `markets.total_yes` or `markets.total_no`
- Increment `markets.bet_count`
- Invalidate `market:{id}` and `markets:active` cache

---

### 3. Market Resolved

**Contract:** `prediction_market`  
**Entrypoint:** `resolve_market`  
**Handler:** `indexer/handlers/market.ts → handleMarketResolved()`

```rust
// Contract emission (to be added)
env.events().publish(
    (symbol_short!("mkt"), symbol_short!("resolved"), market_id),
    MarketResolvedEvent {
        market_id: u64,
        outcome: bool,  // true = YES won, false = NO won
        resolver: Address,
        timestamp: u64,
    }
);
```

**Indexer schema:**
```typescript
interface MarketResolvedEvent {
  marketId: number;
  outcome: boolean;
  resolver: string;
  timestamp: number;
}
```

**Side effects:**
- Update `markets` table: `resolved = true`, `outcome = <outcome>`
- Invalidate all market caches
- Trigger leaderboard recalculation

---

### 4. Market Cancelled

**Contract:** `prediction_market`  
**Entrypoint:** `cancel_market`  
**Handler:** `indexer/handlers/market.ts → handleMarketCancelled()`

```rust
// Contract emission (to be added)
env.events().publish(
    (symbol_short!("mkt"), symbol_short!("cancelled"), market_id),
    MarketCancelledEvent {
        market_id: u64,
        cancelled_by: Address,
        timestamp: u64,
    }
);
```

**Indexer schema:**
```typescript
interface MarketCancelledEvent {
  marketId: number;
  cancelledBy: string;
  timestamp: number;
}
```

**Side effects:**
- Update `markets` table: `cancelled = true`
- Invalidate all market caches

---

### 5. Reward Claimed

**Contract:** `prediction_market`  
**Entrypoint:** `claim`  
**Handler:** `indexer/handlers/claim.ts → handleRewardClaimed()`

```rust
// Contract emission (to be added)
env.events().publish(
    (symbol_short!("claim"), symbol_short!("done"), market_id, user.clone()),
    RewardClaimedEvent {
        market_id: u64,
        user: Address,
        payout: i128,       // XLM payout (0 for losers)
        points: u64,        // Points awarded
        tokens: i128,       // IPREDICT tokens minted
        is_winner: bool,
    }
);
```

**Indexer schema:**
```typescript
interface RewardClaimedEvent {
  marketId: number;
  user: string;
  payout: string;
  points: number;
  tokens: string;
  isWinner: boolean;
}
```

**Side effects:**
- Update `bets` table: `claimed = true`
- Update `leaderboard` cache
- Invalidate `market:{id}` cache

---

### 6. Referral Registered

**Contract:** `referral_registry`  
**Entrypoint:** `register_referral`  
**Handler:** `indexer/handlers/referral.ts → handleReferralRegistered()`

```rust
// Contract emission (to be added)
env.events().publish(
    (symbol_short!("ref"), symbol_short!("reg"), user.clone()),
    ReferralRegisteredEvent {
        user: Address,
        display_name: String,
        referrer: Option<Address>,
        welcome_tokens: i128,
        welcome_points: u64,
    }
);
```

**Indexer schema:**
```typescript
interface ReferralRegisteredEvent {
  user: string;
  displayName: string;
  referrer?: string;
  welcomeTokens: string;
  welcomePoints: number;
}
```

**Side effects:**
- Insert into `referrals` table
- Update `leaderboard` with welcome points

---

### 7. Referral Credited

**Contract:** `referral_registry`  
**Entrypoint:** `credit` (called by prediction_market)  
**Handler:** `indexer/handlers/referral.ts → handleReferralCredited()`

```rust
// Contract emission (to be added)
env.events().publish(
    (symbol_short!("ref"), symbol_short!("credited"), referrer.clone()),
    ReferralCreditedEvent {
        referrer: Address,
        referred_user: Address,
        market_id: u64,
        fee_earned: i128,
        bonus_points: u64,
    }
);
```

**Indexer schema:**
```typescript
interface ReferralCreditedEvent {
  referrer: string;
  referredUser: string;
  marketId: number;
  feeEarned: string;
  bonusPoints: number;
}
```

**Side effects:**
- Update `referrals` table: increment `earnings`, `referral_count`
- Update `leaderboard` with bonus points

---

## Compatibility Rules

### Safe Changes (Non-Breaking)

✅ **Adding optional fields to event payloads**

```rust
// Before
MarketCreatedEvent { id, question, end_time }

// After (safe)
MarketCreatedEvent { id, question, end_time, description: Option<String> }
```

The indexer can safely ignore unknown fields.

✅ **Adding new event types**

New events are ignored by older indexers until handlers are deployed.

✅ **Changing internal contract logic without changing event shape**

---

### Breaking Changes (Require Coordinated Deploy)

❌ **Removing or renaming fields**

```rust
// Breaking: 'question' renamed to 'title'
MarketCreatedEvent { id, title, end_time }
```

Indexer will fail to deserialize or will read undefined values.

❌ **Changing field types**

```rust
// Breaking: end_time changed from u64 to String
MarketCreatedEvent { id, question, end_time: String }
```

❌ **Reordering topics**

```rust
// Breaking: topics reordered
(symbol_short!("created"), symbol_short!("mkt"), market_id)  // Was ("mkt", "created", ...)
```

Indexer filters by topic[0] and topic[1] — reordering breaks routing.

---

### Breaking Change Process

1. **Deprecation Period**
   - Contract emits both old and new event formats for N ledgers (e.g., 1 week)
   - Indexer is updated to handle both formats
   
2. **Migration Window**
   - Indexer deployed with dual-handler support
   - Verification that both formats are being handled correctly
   
3. **Old Format Removal**
   - After migration window, contract stops emitting old format
   - Old handler code can be removed after backfill is complete

---

## Automated Validation

### Contract-Side Check (CI)

A test that extracts all event definitions and generates a JSON schema:

```rust
#[test]
fn generate_event_schema() {
    // Parse lib.rs, extract all env.events().publish() calls
    // Output schemas/contract-events.json
}
```

**Output:** `schemas/contract-events.json`

```json
{
  "market_created": {
    "topics": ["mkt", "created", "u64"],
    "payload": {
      "id": "u64",
      "question": "String",
      "category": "Category",
      "end_time": "u64",
      "creator": "Address"
    }
  }
}
```

### Indexer-Side Check (CI)

A test that validates its handlers against the contract schema:

```typescript
// indexer/test/schema-validation.test.ts
import contractSchema from '../schemas/contract-events.json';
import { eventHandlers } from '../src/handlers';

test('all contract events have handlers', () => {
  for (const eventType of Object.keys(contractSchema)) {
    expect(eventHandlers).toHaveProperty(eventType);
  }
});

test('no handlers for unknown events', () => {
  for (const handler of Object.keys(eventHandlers)) {
    expect(contractSchema).toHaveProperty(handler);
  }
});
```

This check **fails CI** if:
- Contract emits an event the indexer doesn't handle
- Indexer has a handler for a non-existent event

---

## Handler Implementation Reference

**Location:** `indexer/src/handlers/`

| Event | Handler File | Function |
|---|---|---|
| `market_created` | `market.ts` | `handleMarketCreated(event)` |
| `market_resolved` | `market.ts` | `handleMarketResolved(event)` |
| `market_cancelled` | `market.ts` | `handleMarketCancelled(event)` |
| `bet_placed` | `bet.ts` | `handleBetPlaced(event)` |
| `reward_claimed` | `claim.ts` | `handleRewardClaimed(event)` |
| `referral_registered` | `referral.ts` | `handleReferralRegistered(event)` |
| `referral_credited` | `referral.ts` | `handleReferralCredited(event)` |

**Handler template:**

```typescript
export async function handleMarketCreated(
  event: SorobanEvent,
  db: Database,
  cache: Redis
): Promise<void> {
  const data = scValToNative(event.value) as MarketCreatedEvent;
  
  await db.query(
    `INSERT INTO markets (id, question, category, end_time, creator)
     VALUES ($1, $2, $3, $4, $5)`,
    [data.id, data.question, data.category, data.endTime, data.creator]
  );
  
  await cache.del('markets:all', 'markets:active');
}
```

---

## Implementation Status

| Component | Status | Blocking |
|---|---|---|
| Contract event emission | ❌ Not implemented | Yes |
| `schemas/contract-events.json` | ❌ Not implemented | Yes |
| Indexer infrastructure | ❌ Not implemented | Yes |
| Handler implementations | ❌ Not implemented | Yes |
| CI schema validation | ❌ Not implemented | No |
| Event monitoring dashboard | ❌ Not implemented | No |

---

## Future Considerations

### Event Versioning

For major breaking changes, consider versioned events:

```rust
env.events().publish(
    (symbol_short!("mkt"), symbol_short!("created"), symbol_short!("v2"), market_id),
    MarketCreatedEventV2 { ... }
);
```

### Event Compression

For high-frequency events (e.g., `bet_placed` during a market rush), consider batching:

```rust
// Every N bets, emit a single batch event
BetBatchEvent {
    market_id: u64,
    bets: Vec<BetInfo>,  // Vec of (user, amount, is_yes)
}
```

### Cross-Contract Event Ordering

When multiple contracts emit events in a single transaction (e.g., `place_bet` triggers `referral_credited`), indexer must handle events in ledger order, not topic order.

---

## Questions & Decisions

**Q: Should the contract store event emission state to track last emitted ledger?**  
A: No. Events are immutable blockchain records. The indexer maintains the checkpoint, not the contract.

**Q: What happens if indexer falls behind by >1000 ledgers?**  
A: Soroban RPC `getEvents` has pagination limits. Use `startLedger` and `cursor` to page through. Monitor `indexer_lag_ledgers` metric.

**Q: Should events include derived data (e.g., odds calculation in `bet_placed`)?**  
A: No. Emit primitive data only. Indexer computes derived values to avoid contract/indexer logic drift.

---

**Last Updated:** 2024-11-23  
**Authors:** System Documentation  
**Review Cycle:** Update when contracts are modified to emit events

