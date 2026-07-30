# Council Resolution Runbook

> **Phase 1.5 Implementation Guide**  
> How council members submit outcomes and how the aggregator finalizes markets.

---

## Overview

The iPredict oracle uses a **4-of-7 council multisig** model for market resolution. This document covers:

- How council members submit their outcome decisions
- How the aggregator monitors submissions and triggers finalization
- Operational procedures and troubleshooting
- Safety mechanisms to prevent premature or incorrect finalization

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Market Expires                            │
│                  (end_time reached)                          │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼──────┐          ┌──────▼───────┐
│ Council      │          │  Council     │
│ Member 1     │   ...    │  Member 7    │
│ Submits YES  │          │  Submits NO  │
└───────┬──────┘          └──────┬───────┘
        │                        │
        └────────────┬────────────┘
                     │
        ┌────────────▼─────────────┐
        │   PostgreSQL Database    │
        │   council_votes table    │
        │  (market_id, member,     │
        │   outcome, submitted_at) │
        └────────────┬─────────────┘
                     │
        ┌────────────▼─────────────┐
        │   Aggregator Service     │
        │   - Polls every 5s       │
        │   - Counts votes         │
        │   - Validates threshold  │
        └────────────┬─────────────┘
                     │
        ┌────────────▼─────────────┐
        │   Threshold Reached?     │
        │   (4-of-7 agree?)        │
        └────────────┬─────────────┘
                     │
                ┌────┴────┐
                │   YES   │
                └────┬────┘
                     │
        ┌────────────▼─────────────┐
        │  Finalize on Soroban     │
        │  resolve_market(         │
        │    market_id, outcome)   │
        └──────────────────────────┘
```

---

## Council Member: Submitting an Outcome

### Prerequisites

1. **Secret Key**: You have your council member secret key (S...) stored securely
2. **Database Access**: You can connect to the shared PostgreSQL database
3. **Market Data**: You have researched the market outcome from authoritative sources

### Submission Methods

#### Method 1: CLI Tool (Recommended)

```bash
cd oracle
npm run submit -- \
  --market-id 42 \
  --outcome yes \
  --member-key "$COUNCIL_MEMBER_SECRET"
```

**Options:**
- `--market-id <number>`: The market ID to resolve
- `--outcome <yes|no>`: Your outcome decision
- `--member-key <secret>`: Your council member secret key (or set `COUNCIL_MEMBER_SECRET` env var)

**Example:**
```bash
# Submit YES for market 42
npm run submit -- --market-id 42 --outcome yes

# Submit NO for market 123
npm run submit -- --market-id 123 --outcome no
```

#### Method 2: Direct Database Insert

```sql
INSERT INTO council_votes (market_id, member, outcome)
VALUES ('42', 'GMEMBER1PUBLICKEY...', true)
ON CONFLICT (market_id, member)
DO UPDATE SET outcome = EXCLUDED.outcome, submitted_at = NOW();
```

**Notes:**
- `market_id`: The market ID as a string
- `member`: Your Stellar public key (G...)
- `outcome`: `true` for YES, `false` for NO
- `ON CONFLICT` ensures you can update your vote if you change your mind

#### Method 3: HTTP API (if enabled)

```bash
curl -X POST https://oracle.ipredict.io/api/submit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $COUNCIL_API_TOKEN" \
  -d '{
    "marketId": "42",
    "outcome": true,
    "signature": "..."
  }'
```

### Research & Verification

Before submitting, verify the outcome from authoritative sources:

| Category | Primary Source | Secondary Source |
|---|---|---|
| **Crypto** | CoinGecko API | Binance API |
| **Sports** | SportDataAPI | TheOddsAPI |
| **Politics** | Metaculus | PolyMarket |
| **Science** | Research publication | Expert committee |
| **Other** | Multiple sources | Community consensus |

**Checklist:**
- [ ] Market has expired (`end_time` < current timestamp)
- [ ] Outcome is verifiable from at least 2 independent sources
- [ ] No disputes or ambiguity in the market question
- [ ] You are an authorized council member

---

## Aggregator: Monitoring & Finalization

### How the Aggregator Works

The aggregator is a background service that:

1. **Polls** the database every `POLL_INTERVAL_MS` (default: 5 seconds)
2. **Lists** expired, unresolved markets
3. **Counts** council member submissions for each market
4. **Validates** that threshold is reached (4-of-7)
5. **Finalizes** the market on-chain via `resolve_market()`

### Starting the Aggregator

```bash
cd oracle
npm run aggregator
```

**Environment Variables Required:**
```bash
DATABASE_URL=postgresql://user:pass@host:5432/ipredict
SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com
COUNCIL_THRESHOLD=4
COUNCIL_SIZE=7
COUNCIL_MEMBERS=GMEMBER1...,GMEMBER2...,GMEMBER3...,GMEMBER4...,GMEMBER5...,GMEMBER6...,GMEMBER7...
RESOLVER_SECRET_KEY=SRESOLVER...  # Secret key authorized to call resolve_market
MIN_REQUIRED_SUBMISSIONS=4         # Safety: minimum submissions before finalization
POLL_INTERVAL_MS=5000              # Poll every 5 seconds
```

### Finalization Flow

```typescript
// Pseudo-code for aggregator logic
for each expired_unresolved_market {
  const votes = await getCouncilVotes(market.id);
  const tally = computeTally(votes);
  
  // Safety check: minimum submissions
  if (tally.totalVoters < MIN_REQUIRED_SUBMISSIONS) {
    log(`Market ${market.id}: insufficient submissions (${tally.totalVoters}/${MIN_REQUIRED_SUBMISSIONS})`);
    continue;
  }
  
  // Threshold check: 4-of-7 agreement
  const outcome = selectThresholdOutcome(votes, COUNCIL_THRESHOLD);
  if (outcome === null) {
    log(`Market ${market.id}: threshold not reached (${tally.yesVotes} yes, ${tally.noVotes} no)`);
    continue;
  }
  
  // Safety check: prevent double finalization
  if (await isAlreadyFinalized(market.id)) {
    log(`Market ${market.id}: already finalized, skipping`);
    continue;
  }
  
  // Safety check: cancellation race condition
  const currentState = await getMarketState(market.id);
  if (currentState.cancelled || currentState.resolved) {
    log(`Market ${market.id}: cancelled or resolved, skipping`);
    continue;
  }
  
  // Submit finalization on-chain
  await resolveMarketOnChain(market.id, outcome);
  log(`Market ${market.id}: finalized with outcome=${outcome}`);
}
```

### Safety Mechanisms

1. **Minimum Submissions** (`MIN_REQUIRED_SUBMISSIONS`):
   - Prevents finalization based on incomplete data
   - Default: 4 (threshold value) — balanced safety
   - Strict: 7 (all members) — maximum safety
   - Permissive: 1 (any member) — fast finalization (not recommended)

2. **Threshold Enforcement**:
   - At least 4 members must agree on the same outcome
   - Prevents finalization when votes are split 3-4 or 2-5
   - Rejects ambiguous cases where both YES and NO reach threshold

3. **Cancellation Protection**:
   - State is checked before and after vote aggregation
   - Prevents finalizing a market that was cancelled during processing

4. **Double Finalization Guard**:
   - In-memory claim set prevents concurrent finalization attempts
   - Durable state check (database + on-chain) protects across restarts

5. **Vote Deduplication**:
   - Only one vote per council member per market
   - Latest submission wins if a member changes their vote

---

## Database Schema

### `council_votes` Table

```sql
CREATE TABLE council_votes (
  market_id   TEXT NOT NULL,
  member      TEXT NOT NULL,  -- Stellar public key (G...)
  outcome     BOOLEAN NOT NULL,
  submitted_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (market_id, member)
);

CREATE INDEX idx_council_votes_market ON council_votes(market_id);
CREATE INDEX idx_council_votes_submitted ON council_votes(submitted_at DESC);
```

### Query Examples

```sql
-- Get all votes for a market
SELECT member, outcome, submitted_at
FROM council_votes
WHERE market_id = '42'
ORDER BY submitted_at ASC;

-- Count votes by outcome
SELECT
  outcome,
  COUNT(*) as vote_count,
  ARRAY_AGG(member) as members
FROM council_votes
WHERE market_id = '42'
GROUP BY outcome;

-- Find markets with threshold reached
SELECT
  market_id,
  COUNT(*) FILTER (WHERE outcome = true) as yes_votes,
  COUNT(*) FILTER (WHERE outcome = false) as no_votes,
  COUNT(*) as total_votes
FROM council_votes
GROUP BY market_id
HAVING COUNT(*) >= 4  -- at least threshold submissions
  AND (COUNT(*) FILTER (WHERE outcome = true) >= 4
    OR COUNT(*) FILTER (WHERE outcome = false) >= 4);
```

---

## Operational Procedures

### Daily Operations

**Morning Check:**
```bash
# Check aggregator health
systemctl status ipredict-aggregator

# View recent logs
journalctl -u ipredict-aggregator -n 100 --no-pager

# Check for stuck markets (unresolved > 6 hours past expiry)
npm run check-stuck-markets
```

**Per-Market Resolution (Council Member):**
1. Receive notification that market has expired
2. Research outcome from authoritative sources
3. Verify with at least 2 independent data sources
4. Submit your vote via CLI or database
5. Confirm submission was recorded (check logs or database)

**Monitoring (Aggregator Operator):**
1. Ensure aggregator service is running
2. Monitor logs for finalization events
3. Alert on stuck markets (> 6 hours unresolved)
4. Alert on conflicting votes (> 30% dissent)

### Troubleshooting

#### Market Not Finalizing

**Symptom:** Market has expired but remains unresolved for > 1 hour.

**Diagnosis:**
```bash
# Check how many council members have submitted
psql $DATABASE_URL -c "
  SELECT market_id, COUNT(*) as submissions
  FROM council_votes
  WHERE market_id = '42'
  GROUP BY market_id;
"

# Check vote distribution
psql $DATABASE_URL -c "
  SELECT outcome, COUNT(*) as votes
  FROM council_votes
  WHERE market_id = '42'
  GROUP BY outcome;
"
```

**Resolution:**
- **< 4 submissions**: Contact council members who haven't submitted
- **Split vote (3-4 or 2-5)**: Investigate market for ambiguity, may need admin override
- **Aggregator not running**: Start aggregator service
- **Database connection issue**: Check `DATABASE_URL` and network connectivity

#### Incorrect Outcome Finalized

**Symptom:** Market was finalized with the wrong outcome.

**Impact:** High severity — users lose funds incorrectly.

**Immediate Actions:**
1. **DO NOT** manually update database; on-chain state is source of truth
2. Investigate which council members voted incorrectly
3. Review audit logs to identify the data sources used
4. If caught within dispute window, initiate challenge (Phase 2 feature)

**Post-Mortem:**
1. Document what went wrong (data source error, member error, etc.)
2. Update council training materials if needed
3. Consider removing unreliable council members
4. Add automated data source validation if applicable

#### Aggregator Crashed

**Symptom:** Aggregator process exited unexpectedly.

**Diagnosis:**
```bash
journalctl -u ipredict-aggregator -n 500 --no-pager | grep ERROR
```

**Common Causes:**
- Database connection timeout → increase connection pool size
- RPC rate limit → add backoff and retry logic
- Out of memory → increase service memory limit
- Unhandled exception → fix bug and deploy

**Recovery:**
```bash
systemctl restart ipredict-aggregator
systemctl status ipredict-aggregator
```

---

## Security Best Practices

### Council Member Keys

- **NEVER** commit secret keys to version control
- **NEVER** share your secret key with other council members
- **STORE** keys in a secure password manager or hardware wallet
- **ROTATE** keys every 6 months or if compromised
- **USE** environment variables or secure key management service (AWS KMS, HashiCorp Vault)

### Resolver Key

The `RESOLVER_SECRET_KEY` is used by the aggregator to submit the final on-chain resolution.

- Only the aggregator operator should have access to this key
- Store in production secrets manager (not in `.env` file)
- Rotate every 3 months
- Monitor all transactions from this address
- Alert on unexpected `resolve_market` calls

### Database Access

- Council members need read access to `markets` table and write access to `council_votes`
- Use separate database credentials for council members vs aggregator
- Enable audit logging for all `council_votes` writes
- Monitor for suspicious patterns (same member submitting opposite outcomes rapidly)

---

## Monitoring & Alerts

### Key Metrics

| Metric | Threshold | Action |
|---|---|---|
| **Resolution lag** | > 6 hours past expiry | Alert council members |
| **Stuck markets** | > 3 markets unresolved | Investigate aggregator |
| **Conflict rate** | > 30% dissent | Review data sources |
| **Aggregator uptime** | < 99% | Investigate crashes |
| **Submission rate** | < 4 per expired market | Contact inactive members |

### Prometheus Metrics

```typescript
// Exported by aggregator
aggregator_markets_finalized_total         // counter
aggregator_resolution_lag_seconds          // histogram
aggregator_submission_count                // gauge per market
aggregator_conflict_detected_total         // counter
aggregator_errors_total                    // counter by error_type
```

### Example Alert Rules

```yaml
# Prometheus alert rules
groups:
  - name: oracle
    rules:
      - alert: MarketStuck
        expr: max(time() - market_end_time) by (market_id) > 21600  # 6 hours
        labels:
          severity: warning
        annotations:
          summary: "Market {{ $labels.market_id }} unresolved for > 6h"

      - alert: AggregatorDown
        expr: up{job="ipredict-aggregator"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Aggregator service is down"

      - alert: HighConflictRate
        expr: rate(aggregator_conflict_detected_total[1h]) > 0.3
        labels:
          severity: warning
        annotations:
          summary: "High conflict rate in council votes"
```

---

## Testing & Validation

### Local Development

```bash
# Start local PostgreSQL
docker run --name ipredict-db -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16

# Create test database
psql postgresql://postgres:dev@localhost:5432/postgres -c "CREATE DATABASE ipredict_test;"

# Run aggregator in development mode
cd oracle
cp .env.example .env
# Edit .env with local DATABASE_URL and testnet config
npm run dev
```

### Integration Test

```bash
# Test full flow: submit → aggregate → finalize
npm run test:integration
```

### Manual Test Scenario

1. Create a test market on testnet that expires in 5 minutes
2. Submit votes from 4 council members (3 YES, 1 NO)
3. Wait for market to expire
4. Verify aggregator detects the market
5. Verify threshold is reached (3 YES > threshold of 3 for testnet)
6. Verify market is finalized on-chain with outcome=true
7. Verify `council_votes` submissions are preserved (for audit trail)

---

## FAQ

### Q: Can I change my vote after submitting?

**A:** Yes. The database schema has `ON CONFLICT DO UPDATE`, so submitting again overwrites your previous vote. Only your latest submission counts.

### Q: What happens if exactly 3 members vote YES and 4 vote NO?

**A:** The aggregator will finalize with outcome=NO, since 4 >= threshold of 4.

### Q: What if 3 vote YES, 3 vote NO, and 1 hasn't submitted yet?

**A:** The aggregator will wait. Threshold is not reached (neither outcome has >= 4 votes). If the 7th member never submits, the market will be flagged as stuck after 6 hours.

### Q: Can I submit a vote before the market expires?

**A:** Yes, but the aggregator won't process it until `end_time` has passed. Early submissions are allowed to reduce latency.

### Q: What if a market is cancelled or admin-resolved while we're voting?

**A:** The aggregator checks market state before finalization. If `cancelled=true` or `resolved=true`, it will skip finalization. Your votes are preserved for the audit trail but won't trigger on-chain resolution.

### Q: How do I audit past resolutions?

**A:** Query the `council_votes` table to see all submissions for a market:
```sql
SELECT * FROM council_votes WHERE market_id = '42' ORDER BY submitted_at;
```

### Q: What if the aggregator finalizes with the wrong outcome due to a bug?

**A:** The on-chain state is immutable. In Phase 2, there will be a dispute mechanism. For Phase 1.5, admin can cancel payouts and recreate the market if caught quickly. This is why thorough testing is critical.

---

## Appendix: CLI Tool Reference

### `npm run submit`

Submits a council member's outcome decision.

**Usage:**
```bash
npm run submit -- [options]
```

**Options:**
- `--market-id <number>` (required): Market ID to resolve
- `--outcome <yes|no>` (required): Your outcome decision
- `--member-key <secret>`: Council member secret key (or set `COUNCIL_MEMBER_SECRET` env var)
- `--dry-run`: Validate inputs without writing to database

**Examples:**
```bash
# Submit YES for market 42
npm run submit -- --market-id 42 --outcome yes --member-key "$MY_SECRET"

# Dry run to validate
npm run submit -- --market-id 42 --outcome yes --dry-run

# Using environment variable for key
export COUNCIL_MEMBER_SECRET=SMEMBER...
npm run submit -- --market-id 42 --outcome no
```

### `npm run aggregator`

Starts the aggregator service.

**Usage:**
```bash
npm run aggregator
```

**Environment Variables:**
- See "Starting the Aggregator" section above

### `npm run check-stuck-markets`

Lists markets that are expired but unresolved for > 6 hours.

**Usage:**
```bash
npm run check-stuck-markets [--hours 6]
```

**Output:**
```
Stuck Markets Report (> 6 hours past expiry):

Market ID: 42
  Question: Will BTC reach $100k in 2026?
  Expired: 2026-07-28 10:00:00 UTC (8.5 hours ago)
  Submissions: 3/7
    - GMEMBER1: YES
    - GMEMBER2: YES
    - GMEMBER3: NO
  Status: Waiting for 1 more submission to reach threshold

Market ID: 123
  Question: Will Stellar mainnet upgrade succeed?
  Expired: 2026-07-27 14:30:00 UTC (28 hours ago)
  Submissions: 6/7
    - 3 YES, 3 NO
  Status: Split vote, threshold not reached
```

---

## Support & Contact

- **Issues**: File bugs on GitHub Issues with `area:oracle` label
- **Discord**: #oracle-support channel
- **Email**: oracle-support@ipredict.io
- **Documentation**: [docs/ORACLE_AND_BACKEND.md](../../docs/ORACLE_AND_BACKEND.md)

---

**Last Updated:** July 29, 2026  
**Version:** Phase 1.5  
**Status:** Active
