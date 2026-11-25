# Points and Referral Economics

**Version:** 1.0  
**Last Updated:** November 2026  
**Maintained by:** Economics & Product Team

---

## Overview

iPredict's reward system combines three mechanisms:
1. **Leaderboard Points** — Earned by winning bets, capped at top 50 players
2. **Referral Fees** — Split between referrer and referee on new users
3. **Bonus Rules** — Special earning events and promotions

This document consolidates reward rates, splits, and rules across code and documentation.

---

## Part 1: Leaderboard Points System

### How Points Are Earned

Users earn points by successfully predicting market outcomes and claiming their rewards.

| Event | Points | Conditions |
|-------|--------|-----------|
| Win a bet | Based on pool size | Must have placed YES or NO bet and outcome matches |
| Claim reward | +1 (fixed) | Called when claiming winnings after market resolution |

### Point Calculation Formula

```
points_awarded = (pool_total * claim_amount) / total_winners
```

Where:
- `pool_total` = Total XLM bet on winning side
- `claim_amount` = Individual user's XLM claimed
- `total_winners` = Number of unique winners on that side

**Example:**
- Market pool: YES side = 1,000 XLM (100 bettors)
- 60 bettors predicted correctly
- User's winning bet: 10 XLM
- User claims: 10 XLM × (1,000 / 60) = 166.67 points

### Leaderboard Mechanics

**Top 50 Players Tracked:**
- Real-time update on every claim
- Points persist indefinitely (no decay)
- Ties broken by claim timestamp (earlier = higher rank)
- Read from `Config.leaderboard` (cached, O(50) updates)

**Contract Storage:**
- Key: `LeaderboardEntry(rank)` where rank ∈ [1, 50]
- Value: `(address, points, timestamp)`
- Update cost: O(1) on-chain via `upsert_top()`

**On-Chain Updates:**
Called from `claim()` after successful XLM payout:
```
invoke_contract(leaderboard.add_pts, [
  bettor_address,
  points_to_add,
  timestamp
])
```

### View Current Leaderboard

```
GET /api/leaderboard
```

Response:
```json
[
  {
    "rank": 1,
    "address": "GXXXXX...",
    "points": 45321,
    "claimedAt": "2026-11-15T10:30:00Z"
  },
  ...
]
```

---

## Part 2: Referral Fee Economics

### Referral Fee Structure

When a **new user** (never bet before) joins via a referral link, both referrer and referee earn rewards.

#### Who Is a "New User"?

A new user is defined as:
- Address with `is_registered = false` in the database
- First time calling `register_referral()` on-chain
- After registration, all future bets from that address count toward referrer totals

#### Reward Split on First Deposit

| Party | Reward | Triggered On |
|-------|--------|------------|
| **Referrer** | 2% of referee's first bet | When referee places first bet |
| **Referee** | 1% bonus on first bet | When referee places first bet |
| **Platform** | Remaining fees (platform 2% fee) | Standard on all bets |

**Detailed Math:**

Scenario: New user bets 100 XLM for the first time with referrer

1. **Gross amount:** 100 XLM
2. **Platform fee:** 2% = 2 XLM
3. **Referral bonus pool:** 3% = 3 XLM split as:
   - **Referrer receives:** 2% × 100 = 2 XLM
   - **Referee receives:** 1% × 100 = 1 XLM
4. **Net bet amount:** 100 - 2 - 3 = 95 XLM into market

**Result:**
- Referee's bet: 95 XLM (at 95% odds into market)
- Referee bonus: +1 XLM sent immediately
- Referrer bonus: +2 XLM credited (pending claim)

### Referral Tracking

**On-Chain Storage:**
- Key: `Referrer(address)` → returns referrer's address or null
- Key: `ReferralCount(address)` → count of unique referred users

**Off-Chain (PostgreSQL):**
```sql
-- Referral registration
INSERT INTO referrals (referrer, referee, registered_at, bonus_xsf_earned)
VALUES (?, ?, NOW(), ?)

-- Bonus tracking
INSERT INTO referral_bonuses (referrer, referee, bet_amount, bonus_amount, claimed_at)
```

### Claiming Referral Bonuses

**Contract Call:**
```
claim_referral_bonuses(address) → returns total_unclaimed_bonuses
```

**Flow:**
1. Query `ReferralBonuses` for all unclaimed entries where `referrer = address`
2. Sum `bonus_amount` across all entries
3. Transfer total XLM to address
4. Mark all bonuses as claimed
5. Return claimed amount

**On-Chain Protection:**
```rust
// Prevent double-claim
if entry.claimed {
    return ContractError::AlreadyClaimed;
}

// Mark atomic
entry.claimed = true;
invoke_contract(token.transfer, [amount, address])
```

### Referral Link Format

**QR Code / Share Link:**
```
https://ipredict.stellar.app/?referrer=GXXXXX...
https://ipredict.stellar.app/?ref=GXXXXX...
```

**On Landing:**
1. Frontend detects `referrer` param
2. Stores in `sessionStorage` during wallet connection
3. On first bet, includes referrer in `place_bet()` call
4. On-chain verifies referrer exists before crediting

---

## Part 3: Fee Structure (All Users)

### Betting Fees

Charged on every bet placed:

| Fee Type | Rate | Recipient | Notes |
|----------|------|-----------|-------|
| Platform Fee | 2% | Protocol Treasury | Covers operations, infrastructure |
| Referral (new users only) | 2% → referrer<br>1% → referee | Referrer + Referee | Only on first bet from new user |
| Liquidity Pool | 0% (included in platform fee) | Market pools | Implicit — fees cover infrastructure, not pool incentives |

### Detailed Fee Calculation

**Example 1: New user betting 100 XLM with referrer**
```
Gross amount:        100.00 XLM
Platform fee (2%):  -  2.00 XLM
Referral bonuses:   -  3.00 XLM
  Referrer (2%):    -  2.00 XLM
  Referee (1%):     -  1.00 XLM
Net bet:             95.00 XLM → market pool
```

**Example 2: Existing user betting 100 XLM (no referral)**
```
Gross amount:        100.00 XLM
Platform fee (2%):  -  2.00 XLM
Referral bonus:      -  0.00 XLM (not new)
Net bet:             98.00 XLM → market pool
```

**Example 3: User betting 1 XLM (minimum precision)**
```
Gross amount:          1.00 XLM
Platform fee (2%):   - 0.02 XLM
Referee bonus (1%):  - 0.01 XLM (if new)
Net bet:              0.97 XLM
```

Precision verified in `contracts/tests/amount-precision.test.ts` ✓

---

## Part 4: Bonus Rules and Special Events

### Seasonal Bonuses

Promotional periods with increased rewards:

| Season | Dates | Bonus Type | Multiplier | Eligibility |
|--------|-------|-----------|-----------|------------|
| Launch Incentive | Jun 1 - Jun 30, 2026 | 2× referral bonus | 2.0x | New users |
| Summer Campaign | Jul 1 - Aug 31, 2026 | +10% points | 1.1x | All users claiming |
| Hold Bonus | Ongoing | 1 bonus point per 7 days held | 1 pt/week | Unclaimed winnings |

### Leaderboard Position Bonuses

Earned at monthly checkpoints:

| Rank | Bonus | Payout Method |
|------|-------|--------------|
| 1st | 50 XSF token | Contract mint |
| 2-5 | 20 XSF token each | Contract mint |
| 6-10 | 10 XSF token each | Contract mint |
| 11-50 | 1 XSF token each | Contract mint |

**Payout Schedule:** First Monday of each month at 00:00 UTC

**On-Chain Call:**
```
distribute_leaderboard_bonuses(month_id, top_50_addresses)
```

### Early Bird Bonus

New users who register in first 7 days:
- **Bonus:** +5 XLM credited immediately on registration
- **Condition:** No previous on-chain history (new address)
- **Implementation:** 
  ```
  if now() < launch_time + 7 days {
    transfer(EARLY_BIRD_POOL, address, 5_XLM)
  }
  ```

---

## Part 5: Economics Parameters (Configurable)

All reward rates are stored in `Config` contract and can be updated by admin:

```rust
pub struct Config {
    pub platform_fee_bps: u32,           // 200 = 2.00%
    pub referrer_fee_bps: u32,           // 200 = 2.00%
    pub referee_fee_bps: u32,            // 100 = 1.00%
    pub early_bird_bonus_xlm: i128,      // 5_000_000 stroops = 5 XLM
    pub launch_date: u64,                // Unix timestamp
    pub early_bird_duration_secs: u64,   // 7 days = 604_800 secs
}
```

**Update Procedure:**
1. Admin calls `update_config(new_config)`
2. New rates apply to **future transactions only** (no retroactive adjustment)
3. Event emitted: `config_updated`

**Example:** Changing referrer fee from 2% to 3%
```bash
# Contract call
soroban contract invoke --fn update_config \
  --arg config \
    "{\"platform_fee_bps\": 200, \"referrer_fee_bps\": 300, ...}"
```

---

## Part 6: Referral Tracking Dashboard

### For Referrers

**Endpoint:** `GET /api/v1/profile/:address/referrals`

```json
{
  "totalReferred": 42,
  "pendingBonuses": {
    "totalXLM": 125.50,
    "count": 23,
    "details": [
      {
        "referee": "GY3D...",
        "bonusAmount": 5.25,
        "referralDate": "2026-11-15T10:30:00Z",
        "claimed": false
      }
    ]
  },
  "claimedBonuses": {
    "totalXLM": 320.75,
    "count": 19,
    "lastClaimed": "2026-11-14T15:45:00Z"
  }
}
```

### For Referees

**Endpoint:** `GET /api/v1/profile/:address/referrer`

```json
{
  "referredBy": "GXXXXX...",
  "referrerDisplayName": "alice.stellar",
  "firstBetAmount": 50.00,
  "bonusReceived": 0.50,
  "referredDate": "2026-11-15T10:30:00Z"
}
```

---

## Part 7: Referral System Smart Contract Code Locations

### On-Chain (Rust/Soroban)

**File:** `contracts/prediction_market/src/lib.rs`

```
place_bet() line ~180
  → Checks if bettor is new user (not in Referrer map)
  → If referrer param provided: credit referrer with fee
  → Record in ReferralCount() index

claim() line ~250
  → Calls leaderboard.add_pts() with calculated points
  → Checks ReferralsMap for pending bonuses
  → Transfers bonus XLM if found

claim_referral_bonuses() line ~380
  → Public entry point for referrers
  → Returns total unclaimed bonuses
  → Atomically marks all as claimed and transfers XLM
```

### Off-Chain (TypeScript/Backend)

**File:** `backend/src/api/profile.ts`

```
GET /api/v1/profile/:address → parseReferralData()
  → Queries referrals table
  → Calculates pending vs claimed bonuses
  → Formats response with display names
```

**File:** `frontend/src/hooks/useReferral.ts`

```
useReferral(address) → Returns:
  {
    getReferrer(),
    getDisplayName(),
    getReferralCount(),
    getEarnings(),
    isRegistered()
  }
```

**File:** `frontend/src/services/referral.ts`

```
getReferrer(address) → queries on-chain Referrer(address)
getEarnings(address) → sums ReferralBonuses for address
registerReferral(referrer, referee) → transaction flow
```

---

## Part 8: FAQ & Examples

### Q: Can a user act as both referrer and referee?
**A:** Yes. User A can refer User B (earning 2% on B's first bet), while simultaneously being referred by User C (earning 1% bonus on their own first bet).

### Q: What happens if referrer address is invalid?
**A:** On-chain validation rejects the bet with `InvalidReferrer` error. Frontend prevents submission with invalid referrer QR code.

### Q: Can referral bonuses compound?
**A:** No. Bonuses are paid in XLM, not bet amounts. They appear in wallet balance and can be bet in future markets (but those future bets do not earn referral bonuses again).

### Q: How long are bonuses pending?
**A:** Until the referrer explicitly calls `claim_referral_bonuses()`. No automatic expiration.

### Q: Does a user lose referrer status if they go inactive?
**A:** No. Once a referral is established, it's permanent. Referrer continues earning bonuses from future bets of referred users indefinitely.

### Q: What if referrer is on a blocklist?
**A:** Future referrals to blocklisted addresses are rejected. Existing referrals remain valid.

---

## Part 9: Maintenance & Monitoring

### Key Metrics to Track

| Metric | Target | Monitored |
|--------|--------|-----------|
| New user conversion rate | 25% | Daily |
| Avg referral bonus per user | 2.5 XLM | Daily |
| Referral multiplier effect (bet vol through referrals) | 30% of total | Weekly |
| Leaderboard turnover (top 50 changes) | <5% per week | Weekly |
| Unclaimed referral bonuses (escrow) | <5% of monthly rewards | Daily |

### Alerting

- If unclaimed bonuses exceed 10% of rewards → audit bonus distribution
- If referral rate drops below 15% of signups → review incentive structure
- If top 50 stale (no updates) for >7 days → investigate claim activity

---

## Related Documentation

- [All-Features.md](All-Features.md) — Full feature overview
- [ORACLE_AND_BACKEND.md](../ORACLE_AND_BACKEND.md) — Backend data model
- [contracts/prediction_market/README.md](../contracts/prediction_market/README.md) — Smart contract details

---

## Closes #987
