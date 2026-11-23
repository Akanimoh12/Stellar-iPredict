# Oracle Security Threat Model & Checklist

> **Status:** This threat model covers the future oracle system planned for Phase 2.  
> **Current state:** The prediction market uses a trusted admin/resolver model (documented in `docs/AUDIT_AND_SCALE_REPORT.md`).  
> **Purpose:** Enumerate attack vectors, map controls, identify gaps before implementing the decentralized oracle.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Actors & Capabilities](#actors--capabilities)
3. [Attack Surface Analysis](#attack-surface-analysis)
4. [Threat Scenarios by Phase](#threat-scenarios-by-phase)
5. [Bond Economics Analysis](#bond-economics-analysis)
6. [Control Mapping](#control-mapping)
7. [Gap Analysis & Prioritization](#gap-analysis--prioritization)
8. [Operational Security Checklist](#operational-security-checklist)

---

## System Overview

The oracle system is responsible for bringing off-chain event outcomes onto the Stellar blockchain to resolve prediction markets. The design follows a progression from trusted centralized resolution to fully decentralized consensus:

```
Phase 1 (Current):  Single Admin/Resolver
Phase 1.5 (3 mo):   4-of-7 Multisig Council
Phase 2 (6 mo):     Optimistic Oracle with Bonds & Disputes
Phase 3 (12 mo):    Decentralized Network with On-Chain Consensus
```

### Core Security Properties

| Property | Definition | Criticality |
|----------|------------|-------------|
| **Correctness** | Oracle submits the actual real-world outcome | Critical |
| **Availability** | Markets resolve within expected timeframe | High |
| **Finality** | Resolved outcomes cannot be changed | Critical |
| **Censorship Resistance** | No single party can block resolution | Medium |
| **Collusion Resistance** | Economic incentives prevent coordinated manipulation | High |

---

## Actors & Capabilities

### Primary Actors

| Actor | Role | Capabilities | Incentives | Trust Model |
|-------|------|--------------|------------|-------------|
| **Admin** | Contract deployer | • Deploy/upgrade contracts<br>• Register oracle providers<br>• Set bond amounts<br>• Emergency pause | Reputation, platform success | Fully trusted (Phase 1) |
| **Oracle Provider** | Data submitter | • Submit outcomes with bond<br>• Query external APIs<br>• Register as provider | Bond returns, reputation | Trusted (Phase 1.5)<br>Economic (Phase 2+) |
| **Disputer** | Challenge submitter | • Challenge submissions<br>• Post larger bond<br>• Trigger council review | Bond + rewards for correct challenges | Economic |
| **Council Member** | Dispute resolver | • Vote on disputed outcomes<br>• Receive council fees | Council fees, reputation | Trusted (Phase 1.5+) |
| **Bettor** | Market participant | • Bet on market outcomes<br>• Claim payouts<br>• Challenge outcomes (Phase 2) | Maximize payout | Adversarial |
| **Attacker** | Malicious actor | • Attempt to manipulate outcomes<br>• Collude with providers<br>• Exploit vulnerabilities | Financial gain | Adversarial |

### Secondary Actors

- **Data Source APIs** (CoinGecko, SportDataAPI, etc.): Provide off-chain data
- **Stellar Network Validators**: Secure transaction finality
- **Frontend Users**: Interact with markets via UI

---

## Attack Surface Analysis

### 1. Submission Phase

#### Attack: False Outcome Submission

**Scenario:**
```
Market: "Will BTC reach $150k by Dec 31?"
Reality: BTC peaked at $142k (outcome = NO)
Attacker: Submits outcome = YES with bond
Goal: Trigger incorrect payouts to YES bettors
```

**Actor:** Oracle provider (malicious or compromised)

**Preconditions:**
- Attacker has oracle provider role (Phase 1.5) OR sufficient bond (Phase 2)
- Market has not been resolved yet
- Attacker has bet heavily on YES (financial incentive)

**Attack Path:**
1. Attacker bets 10,000 XLM on YES (expected loss if honest resolution)
2. Attacker submits outcome = YES with 100 XLM bond (Phase 2)
3. If unchallenged for 24h, outcome finalizes
4. Attacker claims 20,000 XLM payout (10,000 bet + 10,000 winnings)
5. Net gain: 10,000 XLM (payout) - 100 XLM (bond) - 10,000 XLM (bet) = -100 XLM loss

**Current Controls:**
- Phase 1: Admin manually verifies before calling `resolve_market` (operational control)
- Phase 1.5: 4-of-7 council must agree (3+ malicious required)
- Phase 2: 24h challenge window, bond slashing

**Gaps:**
- Phase 1: Single point of failure (admin key compromise)
- Phase 2: Bond must be >> expected profit from false outcome
- No automated data source verification

**Likelihood:** Low (Phase 1.5+) | **Impact:** Critical | **Priority:** P0

---

#### Attack: Submission Front-Running

**Scenario:**
```
1. Honest provider A submits correct outcome (YES) at time T
2. Attacker B sees pending transaction
3. Attacker B submits incorrect outcome (NO) with higher gas fee
4. If Stellar processes B's transaction first, B's submission is "primary"
```

**Actor:** Malicious oracle provider with mempool visibility

**Current Controls:**
- Stellar's parallel transaction model reduces but doesn't eliminate this risk
- First submission timestamp could be used (not currently implemented)

**Gaps:**
- No "first submission wins" logic
- No delay between submission and finalization to allow multiple submissions

**Likelihood:** Medium (Phase 2) | **Impact:** High | **Priority:** P1

---

### 2. Challenge Phase (Phase 2)

#### Attack: Challenge Spamming

**Scenario:**
```
1. Honest provider submits correct outcome with 100 XLM bond
2. Attacker submits challenges with fake evidence (200 XLM bond each)
3. Each challenge triggers council review (cost + delay)
4. Attacker's goal: Delay resolution beyond market expiry + dispute window
5. Market enters "unresolvable" state → admin forced to cancel
```

**Actor:** Attacker with capital

**Preconditions:**
- Challenge bond < value of delaying/canceling resolution
- Council review has non-zero time cost

**Attack Path:**
1. Attacker bets 50,000 XLM on NO
2. Correct outcome is YES (attacker loses)
3. Attacker submits 10 frivolous challenges (10 × 200 XLM = 2,000 XLM)
4. Each challenge delays finalization by 72h (council review)
5. After 30 days, admin cancels market (all bets refunded)
6. Attacker recovers 50,000 XLM bet, loses 2,000 XLM bonds
7. Net cost: 2,000 XLM to avoid 50,000 XLM loss = 48,000 XLM saved

**Current Controls:**
- Phase 2: Escalating challenge bonds (2nd challenge = 2× bond, 3rd = 4×, etc.)
- Council slashes bonds for frivolous challenges

**Gaps:**
- Escalation factor may not be aggressive enough
- No limit on total number of challenges
- Council review time not bounded

**Likelihood:** High (Phase 2 without mitigations) | **Impact:** High | **Priority:** P0

**Recommended Fix:**
```rust
const MAX_CHALLENGES_PER_MARKET: u32 = 3;
const CHALLENGE_BOND_MULTIPLIER: [i128; 3] = [2, 4, 10]; // 2×, 4×, 10× base bond
const COUNCIL_REVIEW_DEADLINE: u64 = 72 * 3600; // 72 hours max
```

---

#### Attack: Collusion Between Provider & Disputer

**Scenario:**
```
1. Provider A submits correct outcome (YES) with 100 XLM bond
2. Provider B (colluder) challenges with 200 XLM bond + fake evidence
3. If Provider A is malicious but B is honest-appearing:
   - Council may side with B
   - A loses 100 XLM, market resolved incorrectly
4. A and B split the profit from incorrect resolution
```

**Actor:** Two colluding oracle providers

**Attack Path:**
1. Market: "Team X wins match?" — Reality: YES
2. Attacker A and B both bet 10,000 XLM on NO
3. Attacker A submits YES (correct) with 100 XLM bond
4. Attacker B challenges with NO + fabricated "evidence" (200 XLM bond)
5. Council reviews, B's "evidence" appears credible
6. Market resolved NO (incorrect)
7. A loses 100 XLM bond, B loses 200 XLM, but both gain 20,000 XLM payout
8. Net gain: 20,000 - 100 - 200 = 19,700 XLM profit

**Current Controls:**
- Council review (requires 4-of-7 to be fooled or colluding)
- Reputation system (future Phase 3)

**Gaps:**
- No automated fact-checking against multiple data sources
- Council members may not have expertise to verify all evidence types
- No slashing for council members who vote for incorrect outcomes

**Likelihood:** Medium (Phase 2) | **Impact:** Critical | **Priority:** P1

**Recommended Fix:**
- Require 3+ independent data sources to agree before submission
- Council members stake reputation/capital, slashed if consistently wrong
- Implement "wisdom of the crowd" with many small providers vs few large

---

### 3. Council Phase (Phase 1.5+)

#### Attack: Council Collusion

**Scenario:**
```
1. Market has 1M XLM total pool
2. Attacker controls 4-of-7 council seats (via bribery or Sybil)
3. Attacker bets 500K XLM on NO
4. Correct outcome is YES
5. Council votes 4-3 for NO (incorrect)
6. Attacker gains 1M XLM payout - 500K bet = 500K profit
```

**Actor:** Coordinated group controlling council majority

**Preconditions:**
- Council size too small (7 is vulnerable to 4-party collusion)
- Council selection not Sybil-resistant
- Council members not slashed for incorrect votes

**Attack Path:**
1. Attacker registers 4 council member addresses
2. Bet 500K XLM on NO across multiple accounts
3. Correct outcome is YES (all data sources agree)
4. Attacker's 4 council votes force resolution to NO
5. Profit: 1M payout - 500K bets = 500K gain
6. No consequences for council members (gap)

**Current Controls:**
- 4-of-7 threshold requires coordinating 4 parties (operational barrier)
- Council members are publicly known (reputation at risk)

**Gaps:**
- No economic slashing for incorrect council votes
- Council size too small for high-value markets
- No rotation/randomization of council members

**Likelihood:** Low (Phase 1.5), Medium (Phase 2) | **Impact:** Critical | **Priority:** P0

**Recommended Fix:**
```rust
// Adaptive council size based on market size
fn required_council_size(total_pool: i128) -> u32 {
    if total_pool < 10_000_0000000 { 7 }       // < 10K XLM
    else if total_pool < 100_000_0000000 { 15 } // < 100K XLM
    else { 31 }                                  // ≥ 100K XLM
}

// Council members stake, slashed if outvoted by data sources
const COUNCIL_STAKE_PER_VOTE: i128 = 1_000_0000000; // 1,000 XLM
```

---

### 4. Settlement Phase

#### Attack: Payout Manipulation After Resolution

**Scenario:**
```
1. Market resolved correctly (outcome = YES)
2. Attacker finds vulnerability in `claim()` function
3. Attacker claims payout multiple times or for wrong side
```

**Actor:** Technical attacker with contract exploitation skills

**Preconditions:**
- Bug in `claim()` function (e.g., missing `claimed` flag check)
- Reentrancy vulnerability

**Attack Path:**
1. Market resolved YES
2. Attacker bet 1 XLM on YES
3. Attacker calls `claim()` in a loop via recursive contract call
4. Each call sends payout without marking `entry.claimed = true`
5. Contract drained

**Current Controls:**
- `entry.claimed` flag checked before payout (prediction_market contract)
- Soroban prevents reentrancy natively (host runtime protection)

**Gaps:**
- If `claimed` flag is set AFTER payout instead of BEFORE: reentrancy risk
- If multiple bet entries exist: need to check all

**Likelihood:** Very Low (Soroban protections) | **Impact:** Critical | **Priority:** P2 (monitor)

---

### 5. Data Source Attacks

#### Attack: API Manipulation

**Scenario:**
```
Market: "Will ETH reach $10k by Dec 31?"
Data Source: CoinGecko API
Attack:
1. Attacker compromises CoinGecko API (or creates fake endpoint)
2. Oracle provider queries compromised endpoint
3. Receives false data: ETH = $10,050 (reality: $9,500)
4. Provider submits incorrect outcome (YES)
```

**Actor:** Attacker with access to data source infrastructure

**Current Controls:**
- Phase 2: Use 3+ independent data sources (CoinGecko, Binance, CoinMarketCap)
- Require 2-of-3 sources to agree

**Gaps:**
- If 2 sources are compromised: incorrect outcome accepted
- No signature verification on API responses
- No fallback if all sources disagree

**Likelihood:** Low | **Impact:** High | **Priority:** P1

**Recommended Fix:**
```typescript
// Oracle provider logic
async function fetchOutcome(market: Market): Promise<boolean> {
  const sources = [queryCoinGecko, queryBinance, queryCMC];
  const results = await Promise.all(sources.map(fn => fn(market)));
  
  // Require 2-of-3 agreement
  const yesVotes = results.filter(r => r === true).length;
  const noVotes = results.filter(r => r === false).length;
  
  if (yesVotes >= 2) return true;
  if (noVotes >= 2) return false;
  throw new Error("No consensus — manual review required");
}
```

---

##  Bond Economics Analysis

The optimistic oracle (Phase 2) relies on bond economics to prevent false submissions. The bond must make attacks unprofitable.

### Bond Sizing Formula

```
Required Bond = (Expected Profit from False Outcome) × Safety Margin
```

**Example 1: Small Market**
```
Market: 1,000 XLM total pool
Attacker bet: 500 XLM on NO
Correct outcome: YES
False outcome payout: 1,000 XLM (attacker wins entire pool)
Profit from attack: 1,000 - 500 = 500 XLM

Required bond: 500 XLM × 2 = 1,000 XLM (2× safety margin)
```
**Analysis:** Attacker must post 1,000 XLM bond to gain 500 XLM profit (net: -500 XLM) → **Attack unprofitable ✓**

---

**Example 2: Large Market (Gap)**
```
Market: 1M XLM total pool
Attacker bet: 500K XLM on NO
Correct outcome: YES
False outcome payout: 1M XLM
Profit from attack: 1M - 500K = 500K XLM

Required bond: 500K XLM × 2 = 1M XLM

If bond cap = 100K XLM (platform limit):
Attacker risk: 100K XLM bond
Attacker gain: 500K XLM profit
Net: +400K XLM → **Attack profitable ✗**
```

**Gap:** Fixed bond amounts do not scale with market size.

**Recommended Fix:**
```rust
// Adaptive bond based on market pool size
fn required_bond(market: &Market) -> i128 {
    let total_pool = market.total_yes + market.total_no;
    let base_bond = 100_0000000; // 100 XLM
    let scaled_bond = total_pool / 10; // 10% of pool
    
    // Min 100 XLM, max 10% of pool, cap at 1M XLM
    let bond = scaled_bond.max(base_bond).min(1_000_000_0000000);
    bond
}
```

**Result:** 1M XLM market requires 100K XLM bond. If attacker bet 500K on NO:
- Risk: 100K bond + 500K bet = 600K XLM
- Gain: 1M payout = 1M XLM
- Net: +400K XLM still profitable

**Better Fix:** Require bond ≥ 50% of largest single-side bet amount
```rust
let max_side = market.total_yes.max(market.total_no);
let required_bond = max_side / 2; // 50% of winning side
```

For 500K bet: bond = 250K XLM
- Risk: 250K bond + 500K bet = 750K XLM
- Gain: 1M payout
- Net: +250K XLM (still profitable, but reduced)

**Best Fix:** Bond must exceed potential profit
```rust
let potential_profit = total_pool - largest_bet;
let required_bond = potential_profit + safety_margin;
```

---

### Challenge Bond Economics

```
Challenge Bond = Submission Bond × Multiplier
```

**Current Design (Phase 2):**
- Submission bond: 100 XLM
- Challenge bond: 200 XLM (2× multiplier)

**Attack Scenario:**
```
1. Attacker submits false outcome (100 XLM bond)
2. Honest disputer challenges (200 XLM bond)
3. Attacker loses 100 XLM, honest disputer wins 300 XLM total (100 + 200)
4. Attacker's cost: 100 XLM loss
5. Attacker's gain: Delay resolution by 72h

If attacker faces 50K XLM loss from correct resolution:
Cost to delay: 100 XLM per false submission
Benefit: Avoid 50K loss (temporarily)
Spam 10 submissions: 1,000 XLM cost, 720h delay → Market expires
```

**Gap:** Challenge bond multiplier (2×) is not aggressive enough for persistent attackers.

**Recommended Fix:**
```rust
const CHALLENGE_ESCALATION: [f64; 5] = [2.0, 4.0, 10.0, 25.0, 100.0];
// 1st challenge: 2× base, 2nd: 4×, 3rd: 10×, 4th: 25×, 5th: 100×
// After 5 challenges, market locked for council review
```

---

## Control Mapping

| Attack Vector | Phase 1 Control | Phase 1.5 Control | Phase 2 Control | Phase 3 Control | Gaps |
|---------------|-----------------|-------------------|-----------------|-----------------|------|
| **False Outcome Submission** | Admin verifies manually | 4-of-7 council vote | Bond + 24h challenge | DNN consensus | Bond sizing |
| **Submission Front-Running** | Admin controls timing | Council controls timing | First-timestamp priority | Commit-reveal | Not implemented |
| **Challenge Spamming** | N/A (no challenges) | N/A | Escalating bonds | Reputation slashing | Bond escalation too low |
| **Council Collusion** | N/A | 4-of-7 threshold | Council stake slashing | Decentralized | Council size too small |
| **API Manipulation** | Admin verifies sources | Council verifies | 3-of-5 source agreement | Cryptographic proofs | No signature verification |
| **Payout Double-Claim** | `claimed` flag | `claimed` flag | `claimed` flag | `claimed` flag | None (Soroban prevents reentrancy) |
| **Data Source Outage** | Admin manual resolution | Council vote | Fallback sources | Decentralized sources | No automated fallback |

---

## Gap Analysis & Prioritization

### Critical Gaps (P0 — Must Fix Before Phase 2 Launch)

1. **Adaptive Bond Sizing**
   - **Current:** Fixed 100 XLM bond
   - **Issue:** Does not scale with market size (1M XLM market still 100 XLM bond)
   - **Fix:** `required_bond = max(100 XLM, total_pool / 10, potential_profit + margin)`
   - **Effort:** 1 day (contract change)

2. **Challenge Spam Prevention**
   - **Current:** 2× bond multiplier, unlimited challenges
   - **Issue:** Attacker can spam 10+ challenges to delay resolution
   - **Fix:** Escalating bonds (2×, 4×, 10×, 25×, 100×) + 5-challenge cap
   - **Effort:** 2 days (contract change)

3. **Council Size Adaptation**
   - **Current:** Fixed 7-member council
   - **Issue:** 4-of-7 vulnerable to collusion on high-value markets
   - **Fix:** Adaptive council size (7 for <10K XLM, 15 for <100K, 31 for ≥100K)
   - **Effort:** 1 week (governance change + council recruitment)

---

### High Priority (P1 — Before Phase 3)

4. **Multi-Source Data Verification**
   - **Current:** Single API query per provider
   - **Issue:** Compromised API can fool oracle
   - **Fix:** Require 2-of-3 agreement (CoinGecko, Binance, CMC)
   - **Effort:** 3 days (oracle provider logic)

5. **Council Stake Slashing**
   - **Current:** Council votes have no economic consequence
   - **Issue:** Malicious council members not punished
   - **Fix:** Council members stake 1,000 XLM per vote, slashed if outvoted by data
   - **Effort:** 1 week (contract + governance)

---

### Medium Priority (P2 — Phase 3+)

6. **Commit-Reveal for Submissions**
   - **Current:** Submissions visible immediately
   - **Issue:** Front-running possible
   - **Fix:** Two-phase submission (commit hash first, reveal after window)
   - **Effort:** 2 weeks (contract change)

7. **Reputation System**
   - **Current:** No historical tracking
   - **Issue:** No penalty for consistently wrong submissions
   - **Fix:** Track provider accuracy, weight future submissions by reputation
   - **Effort:** 3 weeks (indexer + contract)

---

## Operational Security Checklist

### Pre-Launch (Phase 1.5)

- [ ] Admin key stored in hardware wallet (Ledger/Trezor), never hot wallet
- [ ] 7 council members recruited, identities verified
- [ ] Council members sign code of conduct + NDA
- [ ] 4-of-7 multisig wallet configured for council votes
- [ ] Test resolution flow on 10 testnet markets
- [ ] Document "empty-side" check in resolver procedures (see audit report)
- [ ] Set up monitoring: unresolved markets >48h past expiry → alert
- [ ] Establish communication channel (Discord/Telegram) for council coordination

### Pre-Launch (Phase 2 — Optimistic Oracle)

- [ ] Deploy bond contract with adaptive sizing (10% of pool, min 100 XLM)
- [ ] Deploy challenge escalation (2×, 4×, 10×, 25×, 100× bonds)
- [ ] Implement 5-challenge cap per market
- [ ] Configure 3+ data sources per market category:
  - Crypto: CoinGecko + Binance + CoinMarketCap
  - Sports: SportDataAPI + TheOddsAPI + ESPN
  - Politics: Metaculus + PolyMarket + Reuters
- [ ] Test challenge flow on 20 testnet markets (10 honest, 10 adversarial)
- [ ] Deploy council stake contract (1,000 XLM per vote, slashing logic)
- [ ] Set up automated monitoring:
  - Submission without 2-of-3 source agreement → flag for manual review
  - Challenge rate >10% of markets → investigate
  - Council vote latency >72h → escalate
- [ ] Publish security disclosure policy (bug bounty)

### Ongoing Operations

- [ ] Monthly council rotation (replace 2-of-7 members)
- [ ] Quarterly security review of resolved markets (outcome vs data sources)
- [ ] Track false submission rate per provider, delist if >5%
- [ ] Monitor bond contract balance (must have 2× max payout in reserve)
- [ ] Annual third-party smart contract audit

---

## Recommended Security Reviews

| Review Type | Frequency | Scope | Responsible Party |
|-------------|-----------|-------|-------------------|
| **Code Audit** | Before each phase launch | Smart contracts | External auditor (Halborn, OpenZeppelin) |
| **Data Source Audit** | Quarterly | API reliability + manipulation risk | Internal security team |
| **Council Performance Review** | Monthly | Vote accuracy vs ground truth | Admin + community |
| **Bond Economics Review** | After every 100 markets | Verify attack remains unprofitable | Internal + external economist |
| **Penetration Test** | Annually | Full system (contracts + oracle + UI) | External security firm |

---

## Conclusion

The oracle system's security depends heavily on **bond economics** and **council integrity**. The current design (Phase 1.5) is acceptable for low-value markets (<10K XLM) but requires the following before high-value markets:

1. **Adaptive bond sizing** (scales with market size)
2. **Challenge spam prevention** (escalating bonds + caps)
3. **Council size adaptation** (7 → 15 → 31 members based on value)
4. **Multi-source verification** (2-of-3 API agreement)
5. **Council slashing** (economic penalty for incorrect votes)

**Risk Acceptance:** The admin key compromise risk (Phase 1) is accepted during MVP, mitigated by hardware wallet + operational procedures. Full decentralization (Phase 3) is the long-term goal.

**Next Steps:**
1. Review this document with the core team
2. Prioritize P0 gaps for Phase 2 contract design
3. Begin recruiting council members (target: 15-31 for Phase 1.5)
4. Engage external auditor for Phase 2 contract review

---

**Document Version:** 1.0  
**Last Updated:** 2024-11-24  
**Authors:** Security Team  
**Reviewers:** [Pending — requires 2+ reviewers before Phase 2 launch]
