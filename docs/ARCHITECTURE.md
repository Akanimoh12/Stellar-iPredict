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

See [LOCAL_DEV.md](LOCAL_DEV.md) for local startup, [API.md](API.md) for endpoints, [INDEXER_RUNBOOK.md](INDEXER_RUNBOOK.md) for indexer operations, and [ORACLE_RUNBOOK.md](ORACLE_RUNBOOK.md) for resolution operations.
