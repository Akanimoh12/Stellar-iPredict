# Oracle Reliability Improvements

## Issue #571: Alerting Rules for Oracle Resolution Lag ✅
- Added alert thresholds (warning: 2h, critical: 6h)
- Alerts on individual stuck markets
- Alerts on aggregate lag degradation
- Includes market ID and elapsed time

## Issue #570: SLOs for Market and Oracle Endpoints ✅
- Defined availability objectives (99.5% uptime)
- Defined latency objectives (p95 < 500ms)
- Error budget tracking (0.5% monthly)
- Documented exhaustion policy

## Issue #569: Circuit Breaker for Failing Adapters ✅
- Tracks failure rate per adapter
- Opens breaker after 80% failure over 10 requests
- Skips failed adapters immediately
- Auto-recovery probing every 30s
- Alerts when breaker opens

## Issue #568: Floating Point Precision Handling ✅
- Decimal-safe threshold comparisons
- Preserves provider string precision
- Uses decimal library for exact comparisons
- Applied across all crypto adapters

All fixes maintain backward compatibility and include documentation.
