# iPredict — Oracle & Backend Feature Blueprint

> **Purpose.** This is the shipping blueprint for making the Oracle + Backend
> stack described in [ORACLE_AND_BACKEND.md](ORACLE_AND_BACKEND.md) work in real
> time against **live mainnet contracts**.
>
> `ORACLE_AND_BACKEND.md` is the *design spec* — it says what the system should
> be. This document is the *build order* — what is actually built, what is
> missing, and the sequence to ship it without breaking a live product.
>
> **Status legend**
> | Mark | Meaning |
> |---|---|
> | ✅ | Built and wired into the running path |
> | ⚠️ | Code exists but is **not wired in**, partial, or contradicted elsewhere |
> | ❌ | Not built |
>
> **Branch:** `Oracle-And-Backend` · **Live network:** Stellar Mainnet (Public)

---

## 0. Read This First — Live-System Ground Rules

We are shipping against contracts that hold **real user XLM**. Every feature
below is written to respect four rules:

1. **The chain is the source of truth.** Postgres is a cache/projection. Any
   feature that lets the DB contradict the chain is a bug, not a feature.
2. **The indexer must be replayable.** Any handler we add must be idempotent and
   safe to re-run from ledger N. We already have `(tx_hash, event_index)`
   dedupe — every new write path must use it.
3. **No migration is reversible in production.** Additive-only (`ADD COLUMN`,
   new tables). Never drop or retype a column that a running API reads.
4. **Contract changes are the most expensive change we can make.** Contracts are
   upgradeable (`upgrade()` exists), but an upgrade is a mainnet event with real
   risk. Batch contract changes; do not ship them one at a time.

---

## 1. Critical Blockers — Must Ship Before Anything Else

These are not enhancements. Each one means the live system is currently
producing **incorrect data** or **cannot observe its own state**. Nothing in
Section 3+ is worth building until these are closed.

### 1.1 ❌ `place_bet` emits no event — bets are invisible to the entire backend

**The problem.** [`contracts/prediction_market/src/lib.rs`](../contracts/prediction_market/src/lib.rs)
`place_bet` writes state but **publishes no event**. The only events the market
contract emits are the four `oracle` ones.

Consequences, all of them live right now:

- The `bets` table can never be populated from the chain.
- `markets.total_yes` / `total_no` can never be updated by the indexer.
- `markets.bet_count` can never increment.
- `recomputeTotals` and `recomputeBetCounts` recompute *from the `bets` table* —
  so they are recomputing from an empty source and will happily write zeros.
- Every "volume", "bettors" and "ending soon" sort in the backend is sorting on
  columns that no live writer maintains.

**This is the single highest-priority item in the repo.** Everything downstream
of it — API sorts, leaderboard rebuild, stats, oracle bond math sanity checks —
is reading a projection that is structurally empty.

**Features to build**

| # | Feature | Layer |
|---|---|---|
| 1.1.1 | `BetPlacedEvent` on topics `("mkt","bet")` — fields: `market_id`, `bettor`, `net`, `gross`, `is_yes`, `bet_count`, `total_yes`, `total_no`, `placed_at` | Contract |
| 1.1.2 | Emit typed events for `mkt/created`, `mkt/resolved`, `mkt/cancelled`, `mkt/claimed`, `mkt/fees_withdrawn` — currently the indexer *routes* on these but the contract never *emits* them | Contract |
| 1.1.3 | Include post-state totals in the event payload so the indexer never has to read back from RPC to stay consistent | Contract |
| 1.1.4 | `handleBetPlacedEvent` — upsert `bets` on `(market_id, bettor)`, accumulate net/gross, update market totals + `bet_count` in one transaction | Indexer |
| 1.1.5 | Backfill job to reconstruct historical bets from ledger history for markets already live | Indexer |

> **Sequencing note.** 1.1.1–1.1.3 are contract changes and must ship as **one
> batched `upgrade()`**, not five. Pair with Section 2 (council) so mainnet takes
> one upgrade, not two.

---

### 1.2 ⚠️ Three competing event dispatchers — only one is reachable

There are three separate implementations of "route an event to a handler":

| Location | Dispatch style | Handles | Reachable? |
|---|---|---|---|
| [`indexer/src/event-router.ts`](../indexer/src/event-router.ts) | `(domain, action)` | cancelled, referral ×2, oracle ×3 | Depends on wiring |
| [`indexer/src/index.ts:114`](../indexer/src/index.ts) | `(domain, action)` | above **+ created, resolved** | Depends on wiring |
| [`indexer/src/handlers/index.ts`](../indexer/src/handlers/index.ts) | single flat `topics[0]` | claim, fee_withdrawn, oracle_submission, reward_points, token_mint | `dispatchEvent` is **called by nothing** |
| [`indexer/src/backfill.ts:34`](../indexer/src/backfill.ts) | string-name `if/else` | its own inline SQL, incl. `bet_placed` | Backfill only |

**Orphaned handlers** — written, tested, exported, and never invoked in the live
poll loop: `claim.ts`, `token_mint.ts`, `reward_points.ts`, `fee_withdrawn.ts`,
`oracle_submission.ts`, `market_created.ts`, `market_resolved.ts`.

Note especially: **`oracle/submitted` is never handled by the live router.** We
index challenges, escalations and finalizations but not the submission that
starts the state machine.

**Features to build**

| # | Feature | Layer |
|---|---|---|
| 1.2.1 | Collapse to **one** dispatcher — a single `(domain, action) → handler` registry as the only routing table | Indexer |
| 1.2.2 | Wire every orphaned handler into it, including `oracle/submitted` | Indexer |
| 1.2.3 | Make `backfill.ts` reuse the same registry instead of its own inline SQL, so replay and live indexing cannot diverge | Indexer |
| 1.2.4 | Unknown-event metric + structured warn (never silent `return`) so a new contract event shows up in monitoring instead of vanishing | Indexer |
| 1.2.5 | Registry-completeness test: every `#[contractevent]` topic pair in the contracts has a handler | CI |

---

### 1.3 ⚠️ Duplicate migration prefix `0008`

`0008_council_votes.sql` and `0008_extend_oracle_submissions.sql` share a
number. [`db/migrate.ts`](../db/migrate.ts) tracks applied files by **filename**,
so both will apply — but ordering between them is filesystem-sort dependent, and
any future tooling that assumes a unique version key will break.

**Features to build**

| # | Feature |
|---|---|
| 1.3.1 | Renumber to `0009_extend_oracle_submissions.sql`, cascade `0009_oracle_disputes.sql` → `0010`. **⚠️ Renaming an already-applied migration makes it re-run** — `schema_migrations` keys on filename, so the new name looks unapplied. Both files are `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so a re-run is a no-op — but confirm that on prod before renaming, and backfill `schema_migrations` with the new filenames if not |
| 1.3.2 | Migration linter in CI: fail on duplicate prefixes, non-sequential numbering, or a `DROP`/type-change without an explicit `-- ack:destructive` marker |
| 1.3.3 | `npm run migrate:status` — show applied vs pending against a target DB |

---

### 1.4 ⚠️ `ORACLE_AND_BACKEND.md` header says "Not implemented"

The doc opens with *"Status: Design document only. Not implemented."* while
Option B is implemented on-chain, and the backend/indexer/Redis stack is largely
built. A new contributor reads the header and rebuilds what exists.

**Feature 1.4.1** — rewrite the status header to a per-section status table
pointing at this document as the live tracker.

---

## 2. Trust & Safety — Required Before High-Stakes Markets

### 2.1 ⚠️ The "council" is not a council

`resolve_challenge` calls `require_admin_or_resolver` — meaning **any single
resolver address can unilaterally decide any escalated dispute** and move the
full bond pool. `ORACLE_AND_BACKEND.md` Option C describes 4-of-7 with a
timelock; on-chain there is no threshold, no vote count, no timelock.

The off-chain side ([`oracle/src/config/council.ts`](../oracle/src/config/council.ts),
`council-votes.ts`, `tally.ts`, `hasQuorum`, `meetsThreshold`) computes quorum
correctly — but the contract never verifies it. **Off-chain quorum that the
contract does not enforce is advisory, not security.**

| # | Feature | Layer |
|---|---|---|
| 2.1.1 | On-chain M-of-N: `cast_council_vote(member, market_id, outcome)`, votes stored per member, `resolve_challenge` requires ≥ threshold agreeing votes | Contract |
| 2.1.2 | Council registry on-chain (`add_council_member` / `remove_council_member`, size + threshold in `Config`) | Contract |
| 2.1.3 | Timelock between threshold-reached and funds-moving finalization (spec: 12h) | Contract |
| 2.1.4 | `council_vote_cast` / `council_threshold_reached` events + indexer handlers | Contract + Indexer |
| 2.1.5 | Public dispute page — live vote tally, deadlines, bond amounts | Frontend |

> Ship 2.1.1–2.1.4 **in the same `upgrade()` as 1.1.1–1.1.3.** One mainnet
> upgrade, not two.

### 2.2 ❌ Council-window expiry has no resolution path

`COUNCIL_WINDOW` is 72h, but nothing happens when it lapses. An escalated market
with an inactive council leaves both bonds **stranded in escrow permanently** and
the market unresolved — user funds locked with no recovery path.

| # | Feature |
|---|---|
| 2.2.1 | `expire_council_window(market_id)` — callable by anyone after `council_deadline`: refund both bonds in full, mark the market for admin cancellation |
| 2.2.2 | Escalate `council-inactivity-monitor.ts` from alert-only to paging + auto-invocation of 2.2.1 |
| 2.2.3 | Explicit runbook entry for the deadlocked-council case |

### 2.3 ⚠️ Oracle submission API auth is a hardcoded dev key

[`backend/src/api/oracle.ts`](../backend/src/api/oracle.ts) carries
`DEFAULT_DEV_API_KEY = "test-oracle-api-key"`. If the env var is unset in
production, that constant is the auth boundary on an endpoint that writes oracle
submissions.

| # | Feature |
|---|---|
| 2.3.1 | Refuse to boot when `ORACLE_API_KEY` is unset and `NODE_ENV=production` — never silently fall back |
| 2.3.2 | Verify the submitted `signature` against the provider's Stellar public key (currently accepted as an unchecked opaque string) |
| 2.3.3 | Per-provider keys with rotation, tied into the existing `key-rotation.ts` |
| 2.3.4 | Structured audit log of every submission attempt, accepted or rejected |

### 2.4 ❌ Bond-economics guardrails

Bond constants are compile-time (`SUBMITTER_BOND` 100 XLM, `DISPUTER_BOND` 200
XLM). For a market with a pool far larger than 200 XLM, corrupting the outcome
costs less than the prize — the bond stops being a deterrent.

| # | Feature |
|---|---|
| 2.4.1 | Bond scaled to market size (e.g. `max(SUBMITTER_BOND, pool × bps)`) |
| 2.4.2 | Admin-settable bond params in `Config` rather than recompiled constants |
| 2.4.3 | Alert when any market's pool exceeds a safe multiple of the current bond |
| 2.4.4 | Reconciliation invariant: escrow in == escrow out, asserted per settlement (extends `bond-reconciliation.ts`) |

---

## 3. Real-Time Data Pipeline

### 3.1 Indexer reliability

| # | Feature | Status |
|---|---|---|
| 3.1.1 | 5s poll loop with checkpointing | ✅ |
| 3.1.2 | `(tx_hash, event_index)` idempotency | ✅ |
| 3.1.3 | Dead-letter queue | ✅ |
| 3.1.4 | RPC retry/backoff | ✅ |
| 3.1.5 | Bet/claim/token/points indexing | ❌ blocked on 1.1 + 1.2 |
| 3.1.6 | **Reorg handling** — re-verify last N ledgers, no path today if a ledger is replaced | ❌ |
| 3.1.7 | **Single-writer lock** — advisory lock so two indexer replicas cannot double-write | ❌ |
| 3.1.8 | Automatic DLQ replay with backoff (manual today) | ❌ |
| 3.1.9 | Chain-vs-DB drift detector: sample markets, compare on-chain totals to DB, alert on divergence | ❌ |
| 3.1.10 | Cold-start backfill from contract deploy ledger | ⚠️ partial |

### 3.2 Real-time delivery to the frontend

Everything is poll-based today (frontend polls API, API reads DB, indexer polls
RPC) — three stacked intervals before a user sees a bet land.

| # | Feature |
|---|---|
| 3.2.1 | WebSocket / SSE channel on the backend for market + oracle state changes |
| 3.2.2 | Indexer → Redis pub/sub → API fan-out (not DB polling) |
| 3.2.3 | Frontend live subscription replacing `useVisiblePoll` where it matters (odds, pool totals, dispute state) |
| 3.2.4 | Optimistic UI on bet submit, reconciled by the live event |
| 3.2.5 | Connection-state UI ("live" vs "reconnecting" vs "stale") |

### 3.3 Cache correctness

| # | Feature | Status |
|---|---|---|
| 3.3.1 | Cache-aside + negative caching | ✅ |
| 3.3.2 | Redis rate limiting | ✅ |
| 3.3.3 | Invalidation on cancelled/referral/oracle events | ✅ |
| 3.3.4 | Invalidation on **bet placed** | ❌ blocked on 1.1 |
| 3.3.5 | Stampede protection (single-flight on cold key) | ❌ |
| 3.3.6 | Stale-while-revalidate so a Redis outage degrades instead of failing | ❌ |
| 3.3.7 | Cache hit-rate metric per key class | ❌ |

---

## 4. Backend API Completeness

Spec'd in `ORACLE_AND_BACKEND.md` vs actually registered:

| Endpoint | Spec | Built |
|---|---|---|
| `GET /api/markets` (filter/category/sort/page) | ✅ | ✅ |
| `GET /api/markets/:id` | ✅ | ✅ |
| `GET /api/markets/:id/bets` | ✅ | ⚠️ serves an unpopulated table |
| `GET /api/leaderboard` | ✅ | ✅ |
| `GET /api/stats` | ✅ | ✅ |
| `POST /api/oracle/submit` | ✅ | ⚠️ weak auth (2.3) |
| `GET /api/v1/profile/:address` | — | ✅ |

| # | Feature |
|---|---|
| 4.1 | `GET /api/oracle/submissions` + `/:marketId` — public dispute state, deadlines, bonds |
| 4.2 | `GET /api/oracle/disputes` — active escalations with council tally |
| 4.3 | Unify route prefixes: `leaderboard`/`stats`/`oracle` sit on bare `/api/*` while `profile` is on `/api/v1/*`. Move all under `/api/v1` with redirects from the old paths |
| 4.4 | Cursor pagination for large lists (offset pagination degrades past ~10k rows) |
| 4.5 | ETag / `If-None-Match` on market reads |
| 4.6 | OpenAPI coverage for every route (spec generator is wired; routes registered before it are missing) |
| 4.7 | Per-route rate limits matching the spec table (60/120/10 per min) |

---

## 5. Oracle Automation — Off-Chain

Substantial machinery already exists in [`oracle/src/`](../oracle/src/). The gap
is that most of it is **library code without a scheduler**.

| # | Feature | Status |
|---|---|---|
| 5.1 | Adapters: Binance, CoinMarketCap, TheOddsAPI | ✅ |
| 5.2 | HTTP retry, response cache, normalization | ✅ |
| 5.3 | Per-category resolver mapping | ✅ |
| 5.4 | Council vote tally, quorum, threshold | ✅ off-chain only (see 2.1) |
| 5.5 | Bond reconciliation, conflict detection, stuck-market + inactivity monitors | ✅ as libraries |
| 5.6 | Submit CLI + audit export CLI | ✅ |
| 5.7 | **Scheduler daemon** — run watchers/monitors on a real interval with liveness | ❌ |
| 5.8 | **Auto-submit** on market expiry (detect expired → resolve via adapters → `submit_outcome` with bond) | ❌ |
| 5.9 | **Auto-challenge** — watch submissions, compare against our own resolution, challenge on disagreement | ❌ |
| 5.10 | Multi-source agreement gate: never submit on a single source; require N-of-M adapters to agree | ⚠️ |
| 5.11 | Hot-wallet management for the bond-posting key (balance floor, alerting, spend cap) | ❌ |
| 5.12 | Circuit breaker: stop auto-submitting after K consecutive challenges lost | ❌ |
| 5.13 | Adapters for Politics and Science categories (no source wired) | ❌ |
| 5.14 | Deterministic resolution record — persist the exact source payloads behind every submission for post-hoc dispute defence | ❌ |

---

## 6. Observability

`indexer/src/metrics.ts` and `oracle/src/aggregator/metrics.ts` exist; there is
no scrape endpoint, dashboard, or alert routing.

| # | Feature |
|---|---|
| 6.1 | `/metrics` Prometheus endpoint on backend, indexer and oracle |
| 6.2 | Metric catalogue from the spec: `indexer_lag_ledgers`, `rpc_errors_total`, `events_processed_total`, `api_request_duration_ms`, `cache_hit_rate`, `db_query_duration_ms` |
| 6.3 | Business metrics: markets created, bets placed, volume, markets resolved |
| 6.4 | Oracle metrics: submissions, disputes, resolution lag, bond exposure |
| 6.5 | Alert rules: `IndexerStalled` (>100 ledgers), `HighRPCErrorRate`, `MarketStuck` (>48h past expiry), `HighAPILatency` (p99 >2s), `DatabaseSlow` (p99 >500ms), `CouncilInactive`, `BondEscrowMismatch` |
| 6.6 | Paging integration (PagerDuty/Slack) — alerts must reach a human |
| 6.7 | Grafana dashboards: pipeline health, oracle state machine, business KPIs |
| 6.8 | Request-ID propagation frontend → API → DB (header exists; not threaded through) |
| 6.9 | Public status page |

---

## 7. CI/CD and Release Safety

**[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) covers 2 of 6 units** —
frontend and contracts only. `backend`, `indexer`, `oracle` and `db` all have
vitest configured and hold the majority of recent commits, and **none of them run
in CI.** This is the second-biggest gap after 1.1: the oracle handling real bonds
has no automated gate.

| # | Feature |
|---|---|
| 7.1 | CI matrix covering all six units (test + typecheck + build) |
| 7.2 | Postgres + Redis service containers so DB-backed tests run for real |
| 7.3 | Migration check: apply all migrations to a clean DB every run |
| 7.4 | `cargo audit` + `npm audit --audit-level=high` |
| 7.5 | Secret scanning (spec'd in the doc, never added) |
| 7.6 | Contract WASM build + size/gas regression check |
| 7.7 | Staging deploy on testnet before every mainnet action |
| 7.8 | Contract upgrade playbook: simulate → testnet → verify hash → mainnet, with rollback |
| 7.9 | Reproducible builds — verify deployed WASM hash matches source |
| 7.10 | E2E smoke test against staging: create → bet → submit → challenge → finalize → claim |

---

## 8. Frontend Surfacing

The oracle is fully invisible to users today — no UI exists for submit,
challenge, dispute or finalize.

| # | Feature |
|---|---|
| 8.1 | Oracle state badge on market cards (Submitted / Challenged / Escalated / Finalized) |
| 8.2 | Submit-outcome flow with bond approval + explicit risk disclosure |
| 8.3 | Challenge flow with countdown to `challenge_deadline` |
| 8.4 | Dispute detail page: both bonds, both asserted outcomes, council tally, deadline |
| 8.5 | "Finalizable now" prompt — anyone can call `finalize_outcome`; surface it |
| 8.6 | Bond position tracking in profile (escrowed / returned / lost) |
| 8.7 | Backend-vs-RPC toggle hardening: `USE_BACKEND` flips the whole data source with no per-call fallback — add graceful degradation |
| 8.8 | Full error-code mapping for oracle errors 21–28 into human messages |

---

## 9. Recommended Shipping Order

Dependency-ordered. Each phase is independently deployable.

### Phase 0 — Stop the bleeding *(no contract changes)*
1. Extend CI to all six units — **7.1, 7.2, 7.3**
2. Collapse the three dispatchers into one, wire orphaned handlers — **1.2.1, 1.2.2, 1.2.4**
3. Fix duplicate migration prefix — **1.3.1, 1.3.2**
4. Harden oracle API auth — **2.3.1, 2.3.2**
5. Correct the stale doc header — **1.4.1**

*Exit criterion: CI gates every unit; one routing table; no prod key fallback.*

### Phase 1 — Make the data real *(one batched contract upgrade)*
6. Bet + lifecycle events on-chain — **1.1.1, 1.1.2, 1.1.3**
7. On-chain M-of-N council + timelock — **2.1.1, 2.1.2, 2.1.3, 2.1.4**
8. Council-window expiry escape hatch — **2.2.1**
9. Ship as a **single** `upgrade()`: simulate → testnet → mainnet — **7.8**
10. Bet/claim/points handlers + historical backfill — **1.1.4, 1.1.5**
11. Bet-driven cache invalidation — **3.3.4**

*Exit criterion: `bets` and market totals reconcile against chain state; no
single address can settle a dispute alone.*

### Phase 2 — See what we're running
12. `/metrics` + catalogue — **6.1, 6.2, 6.3, 6.4**
13. Alert rules + paging — **6.5, 6.6**
14. Drift detector + single-writer lock — **3.1.9, 3.1.7**
15. Bond reconciliation invariant — **2.4.4**

*Exit criterion: an indexer stall or bond mismatch pages a human within minutes.*

### Phase 3 — Automate the oracle
16. Scheduler daemon — **5.7**
17. Auto-submit with multi-source agreement — **5.8, 5.10**
18. Auto-challenge — **5.9**
19. Hot-wallet safety + circuit breaker — **5.11, 5.12**
20. Resolution audit records — **5.14**

*Exit criterion: markets resolve without manual intervention; every submission
is defensible from stored evidence.*

### Phase 4 — Real-time UX
21. Pub/sub + WebSocket/SSE — **3.2.1, 3.2.2, 3.2.3**
22. Oracle UI surface — **8.1–8.6**
23. Missing oracle endpoints — **4.1, 4.2**
24. API prefix unification — **4.3**

### Phase 5 — Scale
25. Reorg handling — **3.1.6**
26. Cursor pagination + ETags — **4.4, 4.5**
27. Cache stampede + SWR — **3.3.5, 3.3.6**
28. Dynamic bond sizing — **2.4.1, 2.4.2**
29. Politics/Science adapters — **5.13**

---

## 10. Open Questions

Decisions needed before the relevant phase starts:

1. **Council composition** — who are the 7? Are they known addresses today, or
   does the launch need a selection process? *(blocks 2.1)*
2. **Bond funding** — does the protocol post submitter bonds from a treasury
   wallet, or do we rely on third-party submitters for liquidity? *(blocks 5.8)*
3. **Backfill scope** — reconstruct all historical bets from the deploy ledger,
   or accept a start-from-now cutover with a documented gap? *(blocks 1.1.5)*
4. **Backend cutover** — does `NEXT_PUBLIC_USE_BACKEND` go true for all users at
   once, or do we run a percentage rollout with RPC fallback? *(blocks 8.7)*
5. **Upgrade authority** — `upgrade()` is admin-only today. Should contract
   upgrades themselves require council approval before Phase 1 ships?

---

*Blueprint derived from the code as of branch `Oracle-And-Backend`. Status marks
reflect what is wired into the running path — not merely what exists as a file.*
