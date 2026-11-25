# Audit Findings Tracker

**Report Date:** June 1, 2026  
**Auditor:** Protocol Engineer  
**Status:** Live Tracking  

---

## Critical Findings

### #986-001: Empty-Side Resolution → Funds Stuck

**Severity:** CRITICAL  
**Location:** `contracts/prediction_market/src/lib.rs` - `resolve_market()`  
**Status:** ⚠️ NOT FIXED - Operational mitigation only  

**Description:**
When a market resolves to a side with zero bettors (e.g., resolve YES when total_yes=0), the payout guard prevents division by zero but has no fallback. User funds remain permanently locked in contract.

**Attack Scenario:**
1. Market: "Will BTC hit $150k?" with 1,000 YES bets (50,000 XLM) and 0 NO bets
2. Resolver calls `resolve_market(market_id, outcome=false)`
3. `winning_side = 0` → payout skipped → funds locked forever
4. No recovery path exists

**Required Fix:**
```rust
if outcome && market.total_yes == 0 {
    market.cancelled = true;
    // refund logic
    return Ok(());
}
if !outcome && market.total_no == 0 {
    market.cancelled = true;
    return Ok(());
}
```

**Interim Mitigation (Operational):**
- Resolver must verify both sides have bettors before calling resolve_market
- If one side is empty, call cancel_market instead
- Document in resolver procedures

**Assigned To:** Backend Team  
**Target:** Phase 1.5 (Contract redeploy)  
**Progress:** [ ] Code written [ ] Tested [ ] Deployed to testnet [ ] Deployed to mainnet

---

## High-Severity Findings

### #986-002: Single Admin Key Controls Everything

**Severity:** HIGH (Operational Risk)  
**Location:** Global - Admin Key Management  
**Status:** ⚠️ Partially mitigated

**Description:**
Admin key (`GDZ4VJWNJPLNU3PAWDYX3V5XNATO7X257DPHWRPFXSCCNEUZ7QTXIIUI`) has unrestricted control:
- Create unlimited markets (10/hour rate limit only)
- Cancel any market at any time
- Withdraw all accumulated fees
- Add/remove resolver addresses

**Risk:** Key compromise allows fee drain, market cancellations (users can still refund), but cannot steal user betting pool funds.

**Mitigations Required:**
1. Store admin key in hardware wallet (Ledger/Trezor)
2. Rotate to multisig after launch
3. Add 3+ resolver addresses before promoting to users

**Assigned To:** Operations Team  
**Target:** Before mainnet launch  
**Progress:** [ ] Hardware wallet setup [ ] Resolver addresses added [ ] Multisig planned

---

### #986-003: Single Admin Key for Resolution

**Severity:** HIGH (Operational Risk)  
**Location:** `contracts/prediction_market/src/lib.rs` - `require_admin_or_resolver`  
**Status:** ⚠️ Operational mitigation only

**Description:**
Currently any single resolver can unilaterally resolve disputes. No M-of-N voting, no threshold, no timelock.

**Required:** On-chain council voting (4-of-7 minimum, with 12h timelock)

**Assigned To:** Backend Team  
**Target:** Phase 1 (Contract upgrade)  
**Progress:** [ ] Council registry added [ ] Voting mechanism [ ] Timelock [ ] Events emitted

---

## Medium-Severity Findings

### #986-004: Reentrancy Pattern in `claim()`

**Severity:** MEDIUM (Theoretical on Soroban)  
**Location:** `contracts/prediction_market/src/lib.rs` - `claim()`  
**Status:** ✅ SAFE - Soroban native protection

**Description:**
Order: Transfer → cross-contract calls → mark claimed. On EVM this would be critical. On Soroban it's safe because:
- Soroban host prevents re-entrant calls into same contract
- All calls execute atomically in one transaction
- Host validates auth before execution

**Recommendation:** Mark `claimed = true` before cross-contract calls for defensive coding (no urgency).

**Assigned To:** Code Review  
**Progress:** [ ] Defensive fix applied

---

### #986-005: `get_market_bettors` Does Not Scale

**Severity:** MEDIUM (Scale Risk)  
**Location:** `contracts/prediction_market/src/lib.rs` - `get_market_bettors()`  
**Status:** Known limitation

**Description:**
View function reads one persistent storage entry per bettor. Soft limit ~200-300 entries before response size issues. At 10,000 bettors, function silently truncates or fails.

**Impact:** Frontend display only. Users can always claim rewards regardless.

**Fix Options:**
1. Frontend: Limit display to 100 bettors, link to explorer
2. Phase 2: Off-chain indexer removes need for on-chain loop

**Assigned To:** Frontend Team  
**Target:** Phase 2  
**Progress:** [ ] Frontend limit implemented [ ] Indexer planned

---

### #986-006: Rate Limit Window Can Be Gamed at Boundary

**Severity:** LOW  
**Location:** `contracts/prediction_market/src/lib.rs` - `check_rate()`  
**Status:** Accepted risk

**Description:**
Rolling window allows admin to create 10 markets at time T and 10 more at T+3601 by straddling boundary.

**Impact:** Negligible (admin is trusted, limit prevents accidental spam only).

---

### #986-007: `MAX_BETS_PER_USER = 20` Per Market, Not Global

**Severity:** LOW  
**Location:** `contracts/prediction_market/src/lib.rs`  
**Status:** Accepted - By design

**Description:**
User can bet on every market, 20 times each. Intentional limit prevents slot exhaustion per market, not global spam.

---

## Informational / Verified Correct

### #986-008: Fee Math Precision

**Severity:** INFORMATIONAL  
**Location:** Smart contract fee calculation  
**Status:** ✅ VERIFIED CORRECT

**Fee precision validated:**
- 1 XLM → 0.02 XLM fee, 0.98 XLM net ✓
- 10 XLM → 0.20 XLM fee, 9.80 XLM net ✓
- 100 XLM → 2.00 XLM fee, 98.00 XLM net ✓

Integer arithmetic with `* 9800 / 10000` produces zero drift at all tested amounts.

---

### #986-009: Overflow Protection

**Severity:** INFORMATIONAL  
**Location:** `Cargo.toml`  
**Status:** ✅ VERIFIED

`overflow-checks = true` in release builds. All arithmetic panics on overflow. Soroban traps panics as contract errors.

---

## Frontend Audit Findings

### #986-010: No Guard When Contract IDs Are Empty

**Severity:** MEDIUM  
**Location:** `frontend/src/services/market.ts`  
**Status:** Unfixed

**Description:**
Missing `NEXT_PUBLIC_MARKET_CONTRACT_ID` causes every service call to pass empty string "". RPC returns "contract not found" but shows raw error to user instead of friendly "App not yet configured" message.

**Impact:** Confusing UX during staging/preview deploys.

**Fix:**
```typescript
if (!MARKET_CONTRACT_ID) {
  console.warn("MARKET_CONTRACT_ID not set");
  return null;
}
```

**Assigned To:** Frontend Team  
**Target:** Sprint  
**Progress:** [ ] Guard added [ ] Error message improved

---

### #986-011: `SPONSOR_SECRET_KEY` Pattern in Source

**Severity:** LOW  
**Location:** `frontend/src/services/soroban.ts` line 222  
**Status:** Blank in production

**Description:**
Pattern `NEXT_PUBLIC_` + secret key is dangerous. Currently blank in production, but any developer setting in preview environment would expose it.

**Fix:** Phase 2 - Move to `/api/sponsor` server route.

---

### #986-012: No Mobile-Specific Testing

**Severity:** LOW  
**Location:** Frontend responsive UI  
**Status:** No mobile testing performed

**Description:**
Tailwind responsive classes used but not tested on actual mobile devices or small viewports.

**Assigned To:** QA/Frontend Team  
**Progress:** [ ] Mobile testing on real devices [ ] Viewport tests added

---

## Summary Statistics

| Severity | Count | Resolved | In-Progress | Blocked |
|----------|-------|----------|------------|---------|
| CRITICAL | 1 | 0 | 0 | 1 |
| HIGH | 2 | 0 | 0 | 2 |
| MEDIUM | 4 | 1 | 1 | 2 |
| LOW | 2 | 0 | 0 | 2 |
| INFO | 2 | 2 | 0 | 0 |
| **TOTAL** | **11** | **3** | **1** | **7** |

---

## Pre-Launch Checklist (Before First User Deposit)

- [ ] Critical finding #986-001 fixed and deployed
- [ ] Critical finding #986-003 (council voting) deployed
- [ ] HIGH finding #986-002 (admin key) in hardware wallet
- [ ] 3+ resolver addresses registered via admin panel
- [ ] Frontend contract ID guard (#986-010) implemented
- [ ] Dedicated Soroban RPC endpoint configured
- [ ] Test markets created and full flow verified on mainnet
- [ ] Mobile testing completed (#986-012)
- [ ] cancel_refund tested on cancelled market

---

## Related Issues

- Closes #986
- Related: #1084 (Oracle audit streaming)
- Related: #1085 (DB read replica)
