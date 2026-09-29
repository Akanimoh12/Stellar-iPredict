# Contributor Onboarding & Getting Started Guide

Welcome to **Stellar-iPredict**! This guide is designed to help new contributors understand the codebase structure, set up their local environment, find good starting issues, and submit their first pull request on the `implementation-drips` branch.

---

## 1. Overview & Architecture

iPredict is a decentralized prediction market on Stellar/Soroban. The system is split into distinct components:

| Directory | Service / Purpose | Language / Tech Stack |
|-----------|------------------|-----------------------|
| `backend/` | REST API for markets, bets, leaderboard, stats | Node.js, Fastify, TypeScript, Redis |
| `indexer/` | Soroban event indexer syncing onchain state to Postgres | Node.js, TypeScript, `@stellar/stellar-sdk` |
| `oracle/` | Optimistic & council oracle consensus aggregator | Node.js, TypeScript |
| `db/` | PostgreSQL database migrations and schema definitions | SQL, TypeScript migration runner (`pg`) |
| `contracts/` | Onchain smart contracts (Prediction Market, Token, Referrals, Leaderboard) | Rust, Soroban SDK |
| `frontend/` | Web application | Next.js 14, React, Tailwind CSS |
| `shared/` | Shared TypeScript types and configuration | TypeScript |
| `infra/` | Local Docker Compose setup for Postgres and Redis | Docker, Docker Compose |
| `docs/` | Comprehensive system architecture and reference documentation | Markdown |

---

## 2. Local Setup & Workflow

### Prerequisites
- **Node.js** ≥ 20
- **npm** ≥ 10
- **Docker & Docker Compose** (for local PostgreSQL and Redis)
- **Rust** ≥ 1.85.0 with `wasm32-unknown-unknown` target (only required if working on smart contracts in `contracts/`)

### Setup Instructions

```bash
# 1. Clone the repository
git clone https://github.com/Akanimoh12/Stellar-iPredict.git
cd Stellar-iPredict

# 2. Checkout the active development branch
git checkout implementation-drips

# 3. Install dependencies across all workspaces
npm install

# 4. Start local Postgres & Redis infrastructure
cd infra
docker compose -f docker-compose.dev.yml up -d
cd ..

# 5. Run database migrations
npm run migrate --workspace=ipredict-db
```

### Pre-PR Verification

Before opening any pull request, verify that type checks and tests pass cleanly across all Node services using the automated verification script:

```bash
./scripts/verify-all.sh
```

---

## 3. Guided Path for New Contributors

Below is a curated path of good starting tasks categorized by issue area and difficulty level:

### Area 1: Backend API (`backend/`)
- **Good First Tasks:**
  - Add unit tests for route handlers in `backend/test/`.
  - Add query parameter validation or normalization for new filter options.
  - Enhance OpenAPI documentation annotations in `backend/src/api/`.
- **Reference Docs:** [API Reference](API.md), [Oracle & Backend Architecture](ORACLE_AND_BACKEND.md).

### Area 2: Database & Migrations (`db/`)
- **Good First Tasks:**
  - Add down-migration SQL scripts for un-revertable migrations.
  - Add integration tests verifying migration idempotency and table constraints in `db/test/`.
  - Update schema reference documentation in `docs/DB_SCHEMA.md`.
- **Reference Docs:** [Database Schema Reference](DB_SCHEMA.md).

### Area 3: Event Indexer (`indexer/`)
- **Good First Tasks:**
  - Add loggers or metric counters for unhandled contract event topics in `indexer/src/handlers/`.
  - Write test cases for backfill scripts and checkpoint persistence.
- **Reference Docs:** [Indexer Runbook](INDEXER_RUNBOOK.md).

### Area 4: Oracle Services (`oracle/`)
- **Good First Tasks:**
  - Implement mock data feeds for external resolution adapters in `oracle/src/adapters/`.
  - Add test cases for dispute window duration calculations and council vote aggregation.
- **Reference Docs:** [Oracle & Backend Architecture](ORACLE_AND_BACKEND.md).

### Area 5: Smart Contracts (`contracts/`)
- **Good First Tasks:**
  - Add unit test coverage in `contracts/prediction_market/src/tests.rs`.
  - Improve error code documentation and emit custom events for oracle transitions.
- **Reference Docs:** `contracts/README.md`.

---

## 4. Branching & PR Guidelines

1. **Target Branch:** Always create feature branches off **`implementation-drips`** and open PRs against `implementation-drips` (do **not** target `main`).
2. **Branch Naming:** Use `feat/<short-description>` or `fix/<short-description>`.
3. **Commit Messages:** Write descriptive, professional commit messages avoiding generic or AI-generated fluff.
4. **Verification:** Always run `./scripts/verify-all.sh` locally prior to submitting review requests.

---

## 5. Related Documentation

- [Architecture Overview](ARCHITECTURE.md)
- [API Reference](API.md)
- [Database Schema Reference](DB_SCHEMA.md)
- [Contributing Guidelines](../CONTRIBUTING.md)
- [Glossary](GLOSSARY.md)
