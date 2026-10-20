# Service Level Objectives (Issue #570)

## Availability SLOs

### Market Endpoints
- **Target**: 99.5% uptime per month
- **Error Budget**: 0.5% (216 minutes/month)
- **Measurement**: HTTP 5xx responses and timeouts
- **Window**: Rolling 30 days

### Oracle Resolution
- **Target**: 99.0% successful resolutions
- **Error Budget**: 1.0%
- **Measurement**: Resolution failures / total markets
- **Window**: Rolling 7 days

## Latency SLOs

### Market Creation/Update
- **p95**: < 500ms
- **p99**: < 1000ms
- **Measurement**: End-to-end request latency

### Oracle Resolution
- **p95**: < 5 minutes after expiry
- **p99**: < 10 minutes after expiry
- **Measurement**: Time from market expiry to resolution

## Error Budget Policy

### When Budget Exhausted
1. **Freeze feature work** - Focus on reliability
2. **Root cause analysis** - Mandatory postmortem
3. **Prioritize fixes** - Address systemic issues
4. **Review thresholds** - Adjust if objectives are wrong

### Budget Consumption Tracking
```typescript
// Current consumption visible at /metrics
{
  "availability_budget_remaining": "92.3%",
  "latency_budget_remaining": "85.1%",
  "oracle_budget_remaining": "96.7%"
}
```

### Monthly Review
- Review SLO performance
- Adjust objectives if needed
- Plan reliability work
- Update error budgets

## Critical User Journeys

1. **Create Market** - User creates prediction market
2. **Place Bet** - User places bet on outcome
3. **Resolve Market** - Oracle resolves market at expiry
4. **Claim Winnings** - User claims winnings after resolution

## Measurement

Indicators computed from:
- Prometheus metrics (availability, latency)
- Application logs (errors, successes)
- Oracle resolution logs (lag, failures)

Dashboard: `/monitoring/slos`
