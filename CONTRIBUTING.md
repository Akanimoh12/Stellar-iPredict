# Contributing to iPredict — Backend & Oracle (`implementation-drips`)

We're building the real backend and oracle for iPredict. All of this work
happens on the **`implementation-drips`** branch — not `main`.

## Workflow

1. **Find an issue.** Browse [open issues](../../issues). Filter by `area:` label
   to find work in your wheelhouse:
   - `area:backend` / `area:api` — REST API
   - `area:indexer` — Soroban event indexer
   - `area:db` — database schema, migrations, queries
   - `area:oracle` — council aggregator, optimistic oracle, data adapters
   - `area:contracts` — Soroban contract changes (oracle state machine, bonds)
   - `area:cache` — Redis caching layer
   - `area:infra` — Docker, compose, deployment
   - `area:monitoring` — metrics, dashboards, alerts
   - `area:testing` — tests
   - `area:docs` — documentation
   - Priority: `P0` (needed for launch), `P1`, `P2`.

2. **Claim it.** Comment on the issue so others don't duplicate work.

3. **Branch.** Always branch off `implementation-drips`:
   ```bash
   git checkout implementation-drips
   git pull
   git checkout -b feat/<short-name>     # or fix/, chore/, test/
   ```

4. **Build it.** Each issue has Context, What to build, Acceptance criteria, and
   the target files/folder. Stay within the issue's scope — small, reviewable PRs.

5. **Open a PR — base branch `implementation-drips`.**
   - Link the issue (`Closes #123`).
   - Make sure `npm run typecheck` and `npm test` pass in the package you touched.

> There is **no CI/GitHub Actions** on this branch yet — checks are manual.
> Please run typecheck/tests locally before requesting review.

### Pre-PR verification script

Run the one-liner verification script **before opening a PR**:

```bash
./scripts/verify-all.sh
```

This runs `npm run typecheck` and `npm test` for **all three Node services** — backend, indexer, and oracle — in a single pass. If any step fails, the script exits non-zero and clearly identifies which service failed.

> **Tip:** The script runs every check regardless of intermediate failures, so you can see the full picture without fix-and-re-run cycles.

For the current host-based local workflow across infra, backend, indexer, frontend, and oracle, use [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md).

## Repo layout

```
backend/    REST API (Node + TypeScript, Fastify)
indexer/    Soroban event indexer (Node + TypeScript)
oracle/     Council aggregator, data adapters, submitter, monitor
db/         Shared Postgres migrations + schema
infra/      Docker compose (dev + production)
contracts/  Soroban smart contracts (existing + new oracle code)
frontend/   Next.js app (existing)
docs/       Architecture & design docs
```

Key references:
- [API Reference](docs/API.md) — backend HTTP endpoints, request/response schemas, and error formats.
- [Indexer Runbook](docs/INDEXER_RUNBOOK.md) — running, backfilling, and recovering the event indexer.
- [Synthetic Monitoring](infra/monitoring/synthetic.md) — uptime probes for the API.

## Local setup

```bash
# 1. Install backend, indexer, oracle, and shared dependencies
npm install

# 2. Start Postgres + Redis
cd infra && docker compose -f docker-compose.dev.yml up -d

# 3. Run a service (example: backend)
cd ../backend
cp .env.example .env
npm run dev
```

From the repository root, `npm run typecheck` and `npm test` run checks across all Node workspaces. Service scripts can still be run from their own directories.

The design reference for everything is
[`docs/ORACLE_AND_BACKEND.md`](docs/ORACLE_AND_BACKEND.md).
The implemented and target topology is summarized in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
For end-to-end oracle operations (council + optimistic), see
[`docs/ORACLE_RUNBOOK.md`](docs/ORACLE_RUNBOOK.md).
