# Integration Guide for Oracle Reliability Fixes

## Circuit Breaker Integration (Issue #569)

In your adapter code:

```typescript
import { shouldSkip, recordSuccess, recordFailure } from './circuitBreaker.js';

async function fetchFromProvider(adapterName: string) {
  // Check if adapter should be skipped
  if (shouldSkip(adapterName)) {
    console.log(`Skipping ${adapterName} (circuit breaker open)`);
    return null;
  }
  
  try {
    const result = await providerFetch();
    recordSuccess(adapterName);
    return result;
  } catch (error) {
    recordFailure(adapterName);
    throw error;
  }
}
```

## Decimal Comparison Integration (Issue #568)

Replace floating point comparisons:

```typescript
// OLD (floating point errors)
if (Number(body.price) > threshold) { ... }

// NEW (decimal-safe)
import { exceedsThreshold } from './decimalCompare.js';
if (exceedsThreshold(body.price, threshold)) { ... }
```

## Alert Integration (Issue #571)

From metrics tracking:

```typescript
import { alertStuckMarket, alertAggregateLag } from '../aggregator/alert.js';

// Alert on individual stuck market
if (lagHours > 6) {
  alertStuckMarket(marketId, lagHours);
}

// Alert on aggregate lag
if (avgLag > 1.0) {
  alertAggregateLag(avgLag, affectedCount);
}
```

## Next Steps

1. Integrate circuit breaker into adapter retry logic
2. Replace Number() with decimal comparisons in all adapters
3. Wire alerts into stuck-market.ts and metrics.ts
4. Set up monitoring dashboard for SLOs
