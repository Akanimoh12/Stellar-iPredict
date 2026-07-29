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

## Local setup

```bash
# 1. Start Postgres + Redis
cd infra && docker compose -f docker-compose.dev.yml up -d

# 2. Run a service (example: backend)
cd ../backend
cp .env.example .env
npm install
npm run dev
```

The design reference for everything is
[`docs/ORACLE_AND_BACKEND.md`](docs/ORACLE_AND_BACKEND.md).
