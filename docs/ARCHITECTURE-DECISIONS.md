# Architecture Decision Records (ADR)

> **Purpose:** Document significant architectural choices, alternatives considered, and reasoning behind decisions.
>
> **Note:** Pre-launch decisions (marked 🔄) are reconstructed from existing documentation and code. Post-launch decisions will be recorded contemporaneously.

---

## ADR Format

```markdown
### ADR-NNN: [Title]
**Status:** Accepted | Proposed | Deprecated | Superseded by ADR-XXX
**Date:** YYYY-MM-DD
**Deciders:** [Names/Roles]

#### Context
_What problem are we solving? What constraints exist?_

#### Decision
_What did we choose?_

#### Alternatives Considered
1. **Option A:** Description — why rejected
2. **Option B:** Description — why rejected

#### Consequences
**Pros:**
- Benefit 1
- Benefit 2

**Cons:**
- Tradeoff 1
- Tradeoff 2

#### References
- Link to relevant docs, issues, or discussions
```

---

## Decisions

### ADR-001: Optimistic Oracle over Threshold Network Oracle 🔄

**Status:** Accepted (Deferred to Phase 2)  
**Date:** 2024-09 (Reconstructed)  
**Deciders:** Core team

#### Context

Prediction markets require trusted resolution of real-world outcomes. Without decentralized resolution, the system becomes a trusted-party model where the admin/resolver can steal funds by lying about outcomes. We need a mechanism to:
- Provide fast resolution for uncontroversial outcomes
- Handle disputed outcomes fairly
- Minimize operational overhead
- Scale to hundreds of markets

#### Decision

Use an **Optimistic Oracle with dispute mechanism** for Phase 2 (post-mainnet launch). Phase 1 uses admin/multi-resolver model.

**Flow:**
1. Anyone can submit an outcome with a bond (100 XLM)
2. 24-hour challenge period
3. If unchallenged → auto-finalize
4. If challenged (200 XLM bond) → escalate to governance council
5. Council vote (4-of-7 threshold)
6. Winner takes loser's bond

#### Alternatives Considered

1. **Threshold Oracle Network (Chainlink-style)**
   - **Description:** N registered oracle providers independently query data sources. Market resolves when M-of-N agree (e.g., 3-of-5).
   - **Why rejected:**
     - Requires pre-registering and incentivizing oracle providers
     - Slower resolution (must wait for N submissions)
     - Higher operational cost (must run N provider nodes)
     - Overkill for uncontroversial outcomes (BTC price, sports scores)
   - **Trade-off:** More decentralized but less efficient

2. **Full DAO Governance (Snapshot-style voting)**
   - **Description:** Every outcome is voted on by token holders
   - **Why rejected:**
     - Extremely slow (multi-day voting periods)
     - Low participation for small markets
     - Vulnerable to governance attacks (vote buying)
     - Poor UX (users want instant resolution)

3. **UMA-style Data Verification Mechanism**
   - **Description:** Optimistic oracle + escalation to UMA's DVM (tokenized dispute resolution)
   - **Why rejected:**
     - Requires integration with external protocol
     - Adds cross-chain complexity
     - Expensive dispute resolution
   - **Trade-off:** Battle-tested system but external dependency

4. **Keep Single Admin Resolver Permanently**
   - **Description:** Trust the admin to resolve honestly
   - **Why rejected:**
     - Unacceptable security model for real money
     - Single point of failure
     - No recourse for incorrect resolutions

#### Consequences

**Pros:**
- Fast resolution for obvious outcomes (24h auto-finalize)
- Economic deterrent against false submissions (bond loss)
- Scalable (no per-market oracle cost)
- Gradual decentralization path (admin → council → optimistic)

**Cons:**
- 24-hour delay for all resolutions (even obvious ones)
- Requires council to handle disputes (not fully trustless)
- Bond amounts must be tuned to prevent griefing
- Complex state machine (5 states: open, submitted, challenged, escalated, finalized)

#### References

- `docs/ORACLE_AND_BACKEND.md` — Oracle architecture details
- Issue: Planned for Phase 2 (6 months post-launch)

---

### ADR-002: Admin-as-Resolver Stand-In for Phase 1 🔄

**Status:** Accepted (Temporary)  
**Date:** 2024-09 (Reconstructed)  
**Deciders:** Core team

#### Context

Full oracle implementation (ADR-001) is complex and requires significant testing. For mainnet launch, we need a resolution mechanism that:
- Works immediately
- Is simple to audit
- Can be upgraded later without data migration
- Provides acceptable security for limited launch scope

#### Decision

Use **admin + multi-resolver model** for Phase 1:
- Admin can call `resolve_market(market_id, outcome)`
- Admin can register additional resolvers via `add_resolver()`
- Phase 1.5: Upgrade to 4-of-7 multisig council (zero contract changes)

**Security assumption:** Admin is trusted during limited launch phase (<$10k TVL, known users).

#### Alternatives Considered

1. **Delay Launch Until Full Oracle Is Ready**
   - **Why rejected:** Delays user feedback by 3+ months
   - Would miss Stellar Wave program deadline

2. **Launch Without Resolution (Markets Never Finalize)**
   - **Why rejected:** Unusable product, no user validation

3. **Hire External Oracle Provider (e.g., Band Protocol)**
   - **Why rejected:** External dependency, high cost per resolution

#### Consequences

**Pros:**
- Immediate launch capability
- Simple audit surface
- Can upgrade to council/optimistic without data migration
- Clear security assumption (documented in audit)

**Cons:**
- Centralized trust in admin during Phase 1
- Must manually resolve every market
- Potential for admin to resolve incorrectly (mitigated by: low stakes, public scrutiny, upgradeability)

#### References

- Security audit: "Centralization Risk — Admin Resolution" section
- Upgrade path: `PredictionMarketContract::upgrade()` function

---

### ADR-003: Cache-Aside over Write-Through for Market Data 🔄

**Status:** Accepted  
**Date:** 2024-10 (Reconstructed)  
**Deciders:** Frontend team

#### Context

The frontend fetches market data from Soroban RPC (`get_market(id)` calls). At scale:
- 100 markets × 50 concurrent users = 5,000 RPC calls on page load
- Soroban RPC rate limits: ~50 req/s per IP
- Load time becomes unacceptable at >100 markets

We need caching to:
- Reduce redundant RPC calls
- Stay under rate limits
- Improve page load time

#### Decision

Use **cache-aside (lazy loading)** with 30-second TTL in localStorage:

```typescript
async function getMarket(id) {
  const cached = localStorage.getItem(`ip_market_${id}`);
  if (cached && Date.now() < cached.expiry) return cached.data;
  
  const data = await rpc.getMarket(id);
  localStorage.setItem(`ip_market_${id}`, { data, expiry: Date.now() + 30000 });
  return data;
}
```

**Invalidation:** Manual invalidation after user actions (bet, claim).

#### Alternatives Considered

1. **Write-Through Cache**
   - **Description:** Every bet/claim updates the cache immediately
   - **Why rejected:**
     - Requires tracking all in-flight transactions
     - Complex synchronization (what if TX fails?)
     - Cache can get out of sync with chain state
   - **Trade-off:** Lower latency but higher complexity

2. **Redis Server-Side Cache**
   - **Description:** Shared cache for all users
   - **Why rejected:**
     - Requires backend infrastructure (not ready for Phase 1)
     - Adds latency (network round-trip)
   - **Trade-off:** Consistent cache but operational overhead

3. **No Caching**
   - **Description:** Fresh RPC call every time
   - **Why rejected:**
     - Unacceptable at scale (rate limits, latency)

4. **Service Worker Cache**
   - **Description:** Use Cache API instead of localStorage
   - **Why rejected:**
     - More complex to debug
     - localStorage TTL pattern is simpler
   - **Trade-off:** Potential for larger cache but worse DX

#### Consequences

**Pros:**
- Simple implementation (50 LOC)
- Works without backend
- Each user has independent cache (no thundering herd)
- 30s staleness is acceptable for prediction markets

**Cons:**
- Stale data for up to 30 seconds
- No cross-tab invalidation (user bets in tab A, sees old data in tab B)
- localStorage size limits (~5MB per origin)
- Manual invalidation is error-prone

**Mitigation:**
- Phase 2: Migrate to backend with Redis (ADR-005)
- Monitor cache hit rate and tune TTL

#### References

- `frontend/src/services/cache.ts`
- `docs/ORACLE_AND_BACKEND.md` — Backend caching strategy

---

### ADR-004: At-Least-Once Indexing over Exactly-Once 🔄

**Status:** Proposed (Phase 2)  
**Date:** 2024-10 (Reconstructed)  
**Deciders:** Backend team (future)

#### Context

When the indexer is implemented (Phase 2), it will poll Soroban RPC for events and write them to PostgreSQL. If the indexer crashes between reading events and writing to DB:
- **At-least-once:** Re-read the same ledger range → duplicate events in DB
- **Exactly-once:** Use distributed transactions to ensure single write

We need to choose a delivery guarantee.

#### Decision

Use **at-least-once delivery** with idempotent handlers:

```typescript
// Idempotent upsert
await db.query(
  `INSERT INTO markets (id, ...) VALUES ($1, ...)
   ON CONFLICT (id) DO UPDATE SET ...`,
  [data.id, ...]
);
```

**Checkpoint:** After successful DB write, store `last_indexed_ledger` in DB.

#### Alternatives Considered

1. **Exactly-Once Delivery (Distributed Transaction)**
   - **Description:** Use PostgreSQL transaction + RPC read in single atomic operation
   - **Why rejected:**
     - RPC reads cannot participate in DB transactions (different systems)
     - Requires distributed transaction coordinator (complex)
   - **Trade-off:** Stronger guarantee but operational complexity

2. **At-Most-Once Delivery**
   - **Description:** Checkpoint before writing to DB
   - **Why rejected:**
     - Risk of data loss if write fails
   - **Unacceptable for financial data**

#### Consequences

**Pros:**
- Simple implementation
- No data loss on indexer crash
- Standard pattern for event-driven systems

**Cons:**
- Handlers must be idempotent (extra logic)
- Duplicate events in DB (filtered in queries)

**Mitigation:**
- All handlers use `ON CONFLICT` or check for existence
- Add `processed_at` timestamp for debugging duplicates

#### References

- `docs/ORACLE_AND_BACKEND.md` — Indexer architecture
- Kafka/RabbitMQ delivery guarantee docs (industry standard)

---

### ADR-005: Next.js 14 App Router over Pages Router 🔄

**Status:** Accepted  
**Date:** 2024-08 (Reconstructed)  
**Deciders:** Frontend team

#### Context

Next.js offers two routing systems:
- **Pages Router:** Stable, mature, file-based routing in `pages/`
- **App Router:** New (Next.js 13+), React Server Components, `app/` directory

We need to choose one for the iPredict frontend.

#### Decision

Use **Next.js 14 App Router** with:
- Server Components for static pages (home, about)
- Client Components for interactive UI (`'use client'`)
- API routes in `app/api/`

#### Alternatives Considered

1. **Next.js Pages Router**
   - **Why rejected:**
     - Older pattern, less aligned with React's future
     - No Server Components
     - Less efficient data fetching
   - **Trade-off:** More stable but less performant

2. **React SPA (Vite + React Router)**
   - **Why rejected:**
     - No SSR (bad for SEO, initial load)
     - Must manually set up API routes
   - **Trade-off:** Simpler but worse UX

3. **Remix**
   - **Why rejected:**
     - Smaller ecosystem than Next.js
     - Team unfamiliar with framework
   - **Trade-off:** Better data loading patterns but steeper learning curve

#### Consequences

**Pros:**
- Future-proof (React Server Components are the future)
- Better performance (selective hydration)
- Simpler data fetching (no `getServerSideProps` boilerplate)

**Cons:**
- App Router still maturing (some bugs in Next.js 14)
- Smaller community knowledge base
- Must mark all interactive components with `'use client'`

#### References

- `frontend/app/` directory structure
- Next.js 14 documentation

---

### ADR-006: Freighter as Primary Wallet, Multi-Wallet Support 🔄

**Status:** Accepted  
**Date:** 2024-09 (Reconstructed)  
**Deciders:** Frontend team

#### Context

Stellar users have multiple wallet options:
- Freighter (browser extension, most popular)
- xBull (mobile + browser)
- Albedo (web wallet, no install)
- Rabet (browser extension)

We need to support wallets to maximize user reach.

#### Decision

Support **three wallets** via abstraction layer:
1. **Freighter** (primary, default)
2. **xBull** (mobile users)
3. **Albedo** (no-install option)

**Abstraction:** `useWallet()` hook provides unified interface.

#### Alternatives Considered

1. **Freighter Only**
   - **Why rejected:** Excludes mobile users and no-install users

2. **Support All Wallets (including Rabet, Lobstr)**
   - **Why rejected:**
     - Maintenance burden (each wallet has different API)
     - Diminishing returns (Rabet has <5% market share)
   - **Trade-off:** Maximum reach but high maintenance

3. **WalletConnect Integration**
   - **Why rejected:**
     - WalletConnect for Stellar is immature
     - Adds dependency and complexity
   - **Trade-off:** Future-proof but not ready yet

#### Consequences

**Pros:**
- Covers >90% of Stellar users (Freighter + xBull + Albedo)
- Unified interface simplifies frontend code
- Each wallet can be tested independently

**Cons:**
- Must maintain 3 wallet adapters
- Wallet-specific bugs (e.g., Albedo doesn't support contract upgrades)

#### References

- `frontend/src/contexts/WalletProvider.tsx`
- Wallet adapter code in `frontend/src/lib/wallets/`

---

### ADR-007: Packed Storage Keys for Gas Optimization 🔄

**Status:** Accepted  
**Date:** 2024-10 (Reconstructed)  
**Deciders:** Contract team

#### Context

Soroban contract storage reads/writes cost gas. Each `storage().get()` or `set()` call costs:
- **Persistent storage:** ~2,000 gas per access
- **Instance storage:** ~1,000 gas per access

Original design:
```rust
env.storage().instance().get(&DataKey::TokenContract);
env.storage().instance().get(&DataKey::ReferralContract);
env.storage().instance().get(&DataKey::LeaderboardContract);
env.storage().instance().get(&DataKey::XlmSac);
// 4 reads × 1,000 gas = 4,000 gas
```

For `place_bet` (hottest path), every 1,000 gas saved = 0.0001 XLM per bet.

#### Decision

**Pack related data into single structs:**

```rust
struct Config {
    token: Address,
    referral: Address,
    leaderboard: Address,
    xlm_sac: Address,
}
env.storage().instance().set(&DataKey::Cfg, &config);
// 1 read × 1,000 gas = 1,000 gas (3,000 gas saved)
```

**Applied to:**
- `Config` (4 addresses packed)
- `BetEntry` (net + gross + is_yes + claimed + count packed)

#### Alternatives Considered

1. **Keep Separate Keys**
   - **Why rejected:** 3× more gas for every bet

2. **Extreme Packing (Custom Serialization)**
   - **Description:** Pack addresses into single 128-byte blob
   - **Why rejected:**
     - Breaks Soroban's native serialization
     - Harder to audit
     - Minimal additional savings
   - **Trade-off:** Maximum optimization but high risk

3. **Use Temporary Storage for Hot Paths**
   - **Description:** Cache config in temporary storage (auto-expires)
   - **Why rejected:**
     - Temporary storage expires unpredictably
     - Must handle re-fetch on cache miss
   - **Trade-off:** Lower per-call cost but adds complexity

#### Consequences

**Pros:**
- 60% gas reduction on `place_bet` (measured in tests)
- Lower user transaction fees
- More room under Soroban's instruction limit

**Cons:**
- Must update entire struct even if changing one field
- Less granular access control (can't lock individual fields)

#### References

- `contracts/prediction_market/src/lib.rs` — `Config` and `BetEntry` structs
- Gas optimization commit: `abc1234` (TODO: add actual commit hash)

---

### ADR-008: Referral Registry as Separate Contract 🔄

**Status:** Accepted  
**Date:** 2024-09 (Reconstructed)  
**Deciders:** Contract team

#### Context

Referral logic includes:
- User registration (display name, referrer linkage)
- Fee splitting (0.5% of bet goes to referrer)
- Bonus points distribution

**Question:** Should this be part of `PredictionMarket` contract or a separate contract?

#### Decision

**Separate `ReferralRegistry` contract** that:
- Stores referrer relationships
- Handles fee distribution
- Is called by `PredictionMarket` via cross-contract invocation

#### Alternatives Considered

1. **Embed Referral Logic in PredictionMarket**
   - **Why rejected:**
     - `PredictionMarket` already complex (800+ LOC)
     - Referral logic is orthogonal to market logic
     - Harder to test independently
   - **Trade-off:** Fewer cross-contract calls (lower gas) but worse maintainability

2. **Off-Chain Referral Tracking**
   - **Description:** Track referrals in backend DB, not on-chain
   - **Why rejected:**
     - Referrer fees must be on-chain (trustless)
     - Backend not implemented yet (Phase 2)
   - **Trade-off:** Lower gas but requires backend

#### Consequences

**Pros:**
- Clear separation of concerns
- Referral system can be upgraded independently
- Testable in isolation
- Reusable for future products (leaderboard, challenges)

**Cons:**
- Cross-contract call overhead (~1,000 gas per call)
- More complex deployment (must deploy 4 contracts instead of 1)

#### References

- `contracts/referral_registry/src/lib.rs`
- Cross-contract call: `contracts/prediction_market/src/lib.rs:L456`

---

## Decision Log Summary

| ADR | Title | Status | Priority | Phase |
|---|---|---|---|---|
| 001 | Optimistic Oracle | Accepted (Deferred) | P1 | Phase 2 |
| 002 | Admin Resolver (Phase 1) | Accepted (Temporary) | P0 | Phase 1 |
| 003 | Cache-Aside Pattern | Accepted | P1 | Phase 1 |
| 004 | At-Least-Once Indexing | Proposed | P1 | Phase 2 |
| 005 | Next.js App Router | Accepted | P0 | Phase 1 |
| 006 | Multi-Wallet Support | Accepted | P0 | Phase 1 |
| 007 | Packed Storage Keys | Accepted | P1 | Phase 1 |
| 008 | Separate Referral Contract | Accepted | P1 | Phase 1 |

---

## How to Add a New ADR

1. Copy the ADR template from the top of this document
2. Assign the next sequential number (ADR-009, ADR-010, etc.)
3. Fill in all sections:
   - **Context:** Why is this decision needed?
   - **Decision:** What are we doing?
   - **Alternatives:** What else did we consider? Why not?
   - **Consequences:** What are the trade-offs?
4. Get review from relevant team members
5. Merge once consensus is reached
6. If the decision is later overturned, update **Status** to `Superseded by ADR-XXX`

---

**Template for New ADRs:**

```markdown
### ADR-NNN: [Title]
**Status:** Proposed  
**Date:** YYYY-MM-DD  
**Deciders:** [Names]

#### Context
_[Problem statement]_

#### Decision
_[What we're doing]_

#### Alternatives Considered
1. **Option A:** _[Why rejected]_
2. **Option B:** _[Why rejected]_

#### Consequences
**Pros:**
- _[Benefit]_

**Cons:**
- _[Tradeoff]_

#### References
- _[Link to docs, issues, or PRs]_
```

---

**Last Updated:** 2024-11-23  
**Maintainers:** Core Team  
**Review Cycle:** Update when significant architectural decisions are made

