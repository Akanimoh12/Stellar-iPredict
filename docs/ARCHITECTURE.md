# iPredict Architecture

This document separates what runs today from the intended production path. The detailed API and oracle design is in [ORACLE_AND_BACKEND.md](ORACLE_AND_BACKEND.md).

## Current system

```text
Users
  │
  ▼
Next.js frontend ───── Soroban RPC ───── Stellar contracts
                                               │ events
                                               ▼
                         Indexer ───────── PostgreSQL
                                               ▲
                         Backend API ───────────┘
                              │
                            Redis

Data providers ───── Oracle adapters/council ───── Stellar contracts
```

- `frontend/` is a Next.js application that reads contracts through Soroban RPC and signs transactions through the user's wallet.
- `contracts/` contains the prediction market, token, referral, and leaderboard contracts. The prediction market supports direct resolver calls and the optimistic-oracle lifecycle.
- `indexer/` polls contract events, validates them, and writes market, bet, referral, and oracle state to PostgreSQL. Redis cache entries are invalidated after relevant events.
- `backend/` exposes the indexed read model through Fastify and uses Redis for caching and rate limiting.
- `oracle/` contains provider adapters, council aggregation, submission, dispute, audit, and monitoring code.
- `db/` owns PostgreSQL migrations and seed tooling. `shared/` owns common Node service types, categories, and event topics.

The services exist, but the frontend still has a direct-RPC data path and production deployment remains environment-specific.

## Target production system

```text
                         read requests
Users ─── Next.js ─────────────────────────► Backend API ─── Redis
  │          │                                    │
  │          └── signed transactions              ▼
  │                         ┌─────────────── PostgreSQL ◄──── Indexer
  │                         │                                  ▲
  └────────────────────────►│ Stellar contracts ─── events ───┘
                            │        ▲
Data providers ─► adapters ─┴► oracle council / submitter
                                     │
                              challenge + finalize
```

The target moves high-volume reads to the backend while keeping writes non-custodial. The indexer is the only component that projects on-chain events into the database. Oracle providers retain raw, redacted provenance, aggregate outcomes, and submit or challenge resolutions on-chain. PostgreSQL remains rebuildable from contract events; Redis remains disposable.

## Main flows

### Market reads

1. The frontend requests markets, bets, profiles, and leaderboard data from the backend.
2. The backend serves cached data when available and otherwise reads PostgreSQL.
3. The indexer updates PostgreSQL from finalized Soroban events and invalidates affected cache keys.

### Bets and claims

1. The frontend builds a contract call and the user's wallet signs it.
2. Stellar executes the transaction and emits typed events.
3. The indexer validates and stores those events; the UI reads the resulting projection from the backend.

### Market resolution

1. Category adapters query independent data providers.
2. The oracle records sources, redacted raw values, confidence, and the decision for audit.
3. A confident outcome is submitted on-chain. Conflicting or low-confidence outcomes enter manual review.
4. An unchallenged outcome finalizes after the challenge window; challenged outcomes go to the council.

## Frontend architecture and data flow

The frontend is a Next.js App Router application. Pages compose reusable components, hooks own loading and refresh state, and services isolate API, contract, RPC, cache, and wallet concerns.

```text
App Router page
  ├── components ────── presentational UI and interaction controls
  ├── hooks ─────────── data lifecycle, polling, wallet, and transaction state
  └── services
       ├── api/market/leaderboard/profile
       ├── cache (memory + localStorage)
       └── soroban (RPC and contract transaction helpers)
              │
              ├── NEXT_PUBLIC_USE_BACKEND_API=true ──► backend API
              └── default/direct mode ───────────────► Next.js /api/rpc proxy
                                                        │
                                             public RPC for reads
                                             private RPC for writes
                                                        ▼
                                                  Stellar contracts
```

### Components

- `frontend/src/app/` contains route entry points, layouts, and server route handlers. The RPC proxy is implemented at `app/api/rpc/route.ts`.
- `frontend/src/components/` contains reusable market cards, the betting panel, leaderboard, profile, wallet, navigation, and shared UI primitives.
- Components receive typed domain models and expose callbacks for actions. Hooks and services remain outside presentation components.

### Hooks

- `useMarkets`, `useMarket`, `useLeaderboard`, `useProfile`, and related hooks coordinate loading, stale-while-revalidate state, errors, and refetches.
- `useVisiblePoll` pauses polling while the browser tab is hidden to reduce RPC traffic.
- `useWallet` owns wallet connection state. `useBet`, `useClaim`, `useToken`, and `useReferral` coordinate transaction stages and success/error feedback.
- Hooks map service responses to the shared UI types in `frontend/src/types/` before components consume them.

### Services and data sources

- `services/api.ts` is the feature-flagged read-data client. `NEXT_PUBLIC_USE_BACKEND_API=true` sends reads to `NEXT_PUBLIC_API_URL`; the default relative-path source preserves the existing frontend API routes.
- `services/market.ts`, `leaderboard.ts`, `token.ts`, `referral.ts`, and `profile`-related functions normalize legacy RPC/API responses into frontend types.
- `services/soroban.ts` builds and submits Soroban contract calls, polls transaction status, and exposes simulation and account helpers.
- Wallet and contract actions remain non-custodial: the browser builds a transaction and the connected wallet signs it.

### Cache tiers

The browser cache in `services/cache.ts` has two tiers:

1. **Memory cache:** an in-memory `Map` with short TTL values for immediate navigation and in-flight request de-duplication.
2. **Persistent cache:** `localStorage` with the same entries, allowing stale values to survive reloads.

Cached reads are stale-while-revalidate where hooks seed from stale data and refresh in the background. `getOrSet` shares concurrent loaders and serves a stale value when a refresh fails. If `localStorage` is unavailable or quota-constrained, the cache gracefully falls back to memory and the network.

The RPC proxy also has a separate short-lived edge response cache. It caches only allowlisted read methods, shares in-flight reads, and does not cache transaction submissions or transaction-status polling.

### RPC proxy data flow

The browser normally sends Soroban JSON-RPC requests to same-origin `/api/rpc`. This keeps real upstream endpoints out of the client bundle and centralizes origin checks, rate limiting, method allowlisting, read caching, and read/write routing.

- Public reads such as simulations and ledger-entry lookups use `PUBLIC_RPC_URL` (free/community RPC by default).
- Transaction submission and transaction polling use `SOROBAN_RPC_URL` (the private endpoint when configured).
- Requests are capped by a fixed-window per-IP limiter and rejected unless their origin is allowlisted in production.
- `NEXT_PUBLIC_RPC_PROXY=off` bypasses the proxy for direct-RPC deployments; `NEXT_PUBLIC_SOROBAN_RPC_URL` remains the direct endpoint setting.

### Read and write flows

**Market or leaderboard read:** UI hook → feature-flagged API client or market/leaderboard service → backend API or `/api/rpc` + RPC proxy → Stellar contract or backend read model → cache/re-render.

**Bet or claim write:** UI action → transaction hook → Soroban service builds and simulates the contract call → connected wallet signs → `/api/rpc` routes `sendTransaction` to the private/write RPC → transaction status is polled through the proxy → hooks refresh market, profile, or leaderboard state.

## Ownership and boundaries

| Component | Owns | Does not own |
|---|---|---|
| Frontend | Presentation, wallet interaction, transaction signing | Canonical market state |
| Contracts | Funds, bets, resolution state, payouts | Search and historical projections |
| Indexer | Event ingestion and database projections | Contract decisions |
| Backend | Read APIs, validation, cache and rate limits | User keys or transaction signing |
| Oracle | External evidence, aggregation, provenance, submissions | Custody of user funds |
| PostgreSQL | Queryable off-chain projection and audit data | Canonical on-chain state |
| Redis | Disposable cache and limiter state | Durable records |

## Source layout

```text
backend/    Fastify read API
contracts/  Soroban contracts
db/         PostgreSQL migrations and seed tools
frontend/   Next.js client
indexer/    Soroban event ingestion
oracle/     Data adapters, council, submitter, monitoring
shared/     Shared TypeScript types and event constants
infra/      Local and production service configuration
```

See [LOCAL_DEV.md](LOCAL_DEV.md) for local startup, [API.md](API.md) for endpoints, [INDEXER_RUNBOOK.md](INDEXER_RUNBOOK.md) for indexer operations, [ORACLE_RUNBOOK.md](ORACLE_RUNBOOK.md) for resolution operations, and [RUNBOOK_INDEX.md](RUNBOOK_INDEX.md) for the alert → runbook map.
