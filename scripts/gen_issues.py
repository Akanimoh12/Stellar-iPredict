#!/usr/bin/env python3
"""
Generate and create the 260 iPredict backend/oracle implementation issues.

Each issue gets a consistent, detailed body:
  - Context (why this matters)
  - What to build (concrete scope)
  - Acceptance criteria (checklist)
  - Files / location
  - PR target reminder (implementation-drips)

Usage:
  python3 scripts/gen_issues.py --dry-run        # print titles + counts only
  python3 scripts/gen_issues.py --sample 12      # create only the first N (review)
  python3 scripts/gen_issues.py                  # create ALL (skips existing titles)
"""
import argparse
import json
import subprocess
import sys
import time

REPO = "Akanimoh12/Stellar-iPredict"
BRANCH = "implementation-drips"

# Milestone TITLES (gh issue create --milestone takes the title, not the number)
MS_COUNCIL = "Phase 1.5 — Council Resolution"
MS_BACKEND = "Backend MVP — API + DB + Indexer"
MS_CACHE = "Caching & Performance"
MS_OPTIMISTIC = "Phase 2 — Optimistic Oracle"
MS_DATA = "Oracle Data Layer"
MS_INFRA = "Infrastructure & Deployment"
MS_MONITOR = "Monitoring & Alerting"
MS_TESTING = "Testing & Hardening"


def body(context, what, criteria, location, extra=""):
    crit = "\n".join(f"- [ ] {c}" for c in criteria)
    extra_block = f"\n## Notes\n{extra}\n" if extra else ""
    return f"""## Context
{context}

## What to build
{what}

## Acceptance criteria
{crit}

## Files / location
`{location}`
{extra_block}
---
**PR target:** open your PR against the `{BRANCH}` branch (not `main`).
Reference: [`docs/ORACLE_AND_BACKEND.md`](../blob/{BRANCH}/docs/ORACLE_AND_BACKEND.md).
There is no CI on this branch yet — run `npm run typecheck` and `npm test` locally before review.
"""


# Each entry: (title, [labels], milestone, body)
ISSUES = []


def add(title, labels, ms, context, what, criteria, location, extra=""):
    ISSUES.append((title, labels, ms, body(context, what, criteria, location, extra)))


# ──────────────────────────────────────────────────────────────────────────────
# DATABASE  (area:db)  — ~30
# ──────────────────────────────────────────────────────────────────────────────
add("[DB] Create `markets` table migration",
    ["area:db", "P0"], MS_BACKEND,
    "The backend serves an indexed copy of on-chain markets. We need the base table.",
    "Write migration `0001_create_markets.sql` matching the schema in the design doc "
    "(id, question, image_url, category, end_time, total_yes, total_no, resolved, "
    "outcome, cancelled, creator, bet_count, created_at, updated_at).",
    ["Migration file `db/migrations/0001_create_markets.sql` exists",
     "Column types match the design doc (NUMERIC(30,7) for amounts, CHAR(56) for addresses)",
     "Running it against a clean Postgres creates the table without error",
     "Includes `IF NOT EXISTS` / is safely re-runnable or documented as forward-only"],
    "db/migrations/0001_create_markets.sql")

add("[DB] Add indexes on `markets` (category, resolved, active)",
    ["area:db", "P0"], MS_BACKEND,
    "Market list queries filter by category and active/resolved state; these need indexes.",
    "Add `idx_markets_category`, `idx_markets_resolved(resolved,end_time)`, and "
    "`idx_markets_active(resolved,cancelled,end_time)`.",
    ["Three indexes created in a migration",
     "EXPLAIN on a filtered `SELECT ... WHERE resolved=false AND cancelled=false` uses the index"],
    "db/migrations/0002_markets_indexes.sql")

add("[DB] Create `bets` table migration",
    ["area:db", "P0"], MS_BACKEND,
    "Per-bettor positions per market power the profile and market-detail pages.",
    "Create the `bets` table (market_id FK, bettor, net_amount, gross_amount, is_yes, "
    "claimed, created_at) with composite PK (market_id, bettor).",
    ["Migration creates the table with the composite primary key",
     "Foreign key to markets(id)",
     "`idx_bets_bettor` index present"],
    "db/migrations/0003_create_bets.sql")

add("[DB] Create `leaderboard` table migration",
    ["area:db", "P0"], MS_BACKEND,
    "Leaderboard is served from a snapshot table rebuilt from events.",
    "Create `leaderboard` (address PK, display_name, points, won_bets, lost_bets, "
    "updated_at) plus `idx_lb_points(points DESC)`.",
    ["Table + descending points index created",
     "Re-runnable / forward-only as documented"],
    "db/migrations/0004_create_leaderboard.sql")

add("[DB] Create `events` audit-log table migration",
    ["area:db", "P0"], MS_BACKEND,
    "Raw on-chain events are stored for audit and replay.",
    "Create `events` (id BIGSERIAL PK, ledger_seq, tx_hash, event_type, market_id, "
    "actor, payload JSONB, created_at) + indexes on market_id, event_type, ledger_seq DESC.",
    ["Table and three indexes created",
     "payload is JSONB"],
    "db/migrations/0005_create_events.sql")

add("[DB] Build a SQL migration runner",
    ["area:db", "P0"], MS_BACKEND,
    "Migrations must apply in order and be tracked so we don't double-apply.",
    "Implement a small migration runner (Node/TS) that applies `db/migrations/*.sql` "
    "in filename order and records applied versions in a `schema_migrations` table.",
    ["`npm run migrate` applies all pending migrations",
     "Already-applied migrations are skipped",
     "Failure rolls back the current migration in a transaction",
     "`schema_migrations` table tracks applied filenames + timestamp"],
    "db/migrate.ts (or backend/src/db/migrate.ts)")

add("[DB] Postgres connection pool module",
    ["area:db", "area:backend", "P0"], MS_BACKEND,
    "Both backend and indexer need a shared, pooled pg client.",
    "Create a reusable pg Pool wrapper reading `DATABASE_URL`, with sane pool size, "
    "timeouts, and a `query<T>()` helper that types rows.",
    ["Single exported pool, configurable size via env",
     "Typed `query` helper",
     "Graceful shutdown closes the pool"],
    "backend/src/db/pool.ts")

add("[DB] Seed script for local development data",
    ["area:db", "P1"], MS_BACKEND,
    "Contributors need realistic local data without running a full indexer.",
    "Write a seed script that inserts a handful of markets, bets, and leaderboard rows.",
    ["`npm run seed` populates a local DB",
     "Idempotent (safe to run twice)",
     "Documented in db/README.md"],
    "db/seed.ts")

add("[DB] `oracle_submissions` table migration (Phase 2)",
    ["area:db", "area:oracle", "P1"], MS_OPTIMISTIC,
    "The optimistic/council oracle records each provider submission off-chain for monitoring.",
    "Create `oracle_submissions` (id, market_id, submitter, outcome, bond_amount, "
    "submitted_at, status) with indexes on market_id and status.",
    ["Table + indexes created",
     "status enum/check covers submitted|challenged|finalized|rejected"],
    "db/migrations/0006_oracle_submissions.sql")

add("[DB] `oracle_disputes` table migration (Phase 2)",
    ["area:db", "area:oracle", "P1"], MS_OPTIMISTIC,
    "Disputes/challenges need their own record for the dispute council flow.",
    "Create `oracle_disputes` (id, submission_id FK, disputer, disputer_bond, "
    "opened_at, resolved_at, resolution).",
    ["Table created with FK to oracle_submissions",
     "Index on submission_id"],
    "db/migrations/0007_oracle_disputes.sql")

for n, (title, what, loc) in enumerate([
    ("markets upsert query", "Implement `upsertMarket()` that inserts or updates a market row from decoded event data (ON CONFLICT id).", "backend/src/db/markets.ts"),
    ("getMarkets paginated query", "Implement `getMarkets({filter, category, sort, page, limit})` returning rows + total count.", "backend/src/db/markets.ts"),
    ("getMarketById query", "Implement `getMarketById(id)` returning a single market or null.", "backend/src/db/markets.ts"),
    ("bets upsert query", "Implement `upsertBet()` accumulating net_amount on conflict (market_id, bettor).", "backend/src/db/bets.ts"),
    ("getBetsByMarket query", "Implement paginated `getBetsByMarket(marketId, page, limit)`.", "backend/src/db/bets.ts"),
    ("getBetsByBettor query", "Implement `getBetsByBettor(address)` for the profile page.", "backend/src/db/bets.ts"),
    ("leaderboard upsert query", "Implement `upsertLeaderboardEntry()` adjusting points/won/lost.", "backend/src/db/leaderboard.ts"),
    ("getLeaderboard query", "Implement paginated `getLeaderboard({offset, limit, sort})`.", "backend/src/db/leaderboard.ts"),
    ("global stats query", "Implement `getGlobalStats()` (total markets, volume, users, bets).", "backend/src/db/stats.ts"),
    ("event insert query", "Implement `insertEvent()` writing a raw event row (idempotent on tx_hash+log index).", "backend/src/db/events.ts"),
    ("checkpoint store queries", "Implement `getCheckpoint()` / `saveCheckpoint(ledger)` for the indexer.", "backend/src/db/checkpoint.ts"),
    ("DB transaction helper", "Add a `withTransaction(fn)` helper that begins/commits/rolls back.", "backend/src/db/tx.ts"),
], start=1):
    add(f"[DB] Query: {title}", ["area:db", "P0" if n <= 8 else "P1"], MS_BACKEND,
        "Typed query functions form the data-access layer shared by API and indexer.",
        what,
        ["Function is exported and typed", "Parameterized (no string interpolation of inputs)",
         "Unit test covers the happy path", "Returns shapes documented in a TS type"],
        loc)

add("[DB] Define shared TS types for DB rows",
    ["area:db", "P0"], MS_BACKEND,
    "API and indexer must agree on row shapes.",
    "Create TS interfaces for Market, Bet, LeaderboardEntry, EventRow mirroring the schema.",
    ["Types exported from a single module", "Numeric/amount fields typed consistently",
     "Reused by query functions"],
    "backend/src/db/types.ts")

add("[DB] Connection retry + health check",
    ["area:db", "P1"], MS_BACKEND,
    "Transient DB outages shouldn't crash services on boot.",
    "Add startup retry with backoff and a `pingDb()` health function.",
    ["Boot retries on ECONNREFUSED with capped backoff", "`pingDb()` returns ok/latency"],
    "backend/src/db/health.ts")

add("[DB] Document the schema in db/README.md",
    ["area:db", "area:docs", "P2"], MS_BACKEND,
    "Contributors need a single place describing every table and column.",
    "Expand db/README.md with a table-by-table description and an ER diagram (mermaid).",
    ["Every table documented", "Mermaid ER diagram renders on GitHub"],
    "db/README.md")


# ──────────────────────────────────────────────────────────────────────────────
# INDEXER  (area:indexer)  — ~40
# ──────────────────────────────────────────────────────────────────────────────
add("[INDEXER] getEvents RPC client with pagination",
    ["area:indexer", "P0"], MS_BACKEND,
    "The indexer reads contract events from Soroban RPC `getEvents()` page by page.",
    "Implement a client that calls `getEvents({startLedger, filters, limit, cursor})` and "
    "follows the cursor until the page is exhausted, returning decoded events + latestLedger.",
    ["Handles cursor pagination within a poll", "Filters by the configured contract IDs",
     "Returns latestLedger for checkpointing", "Surfaces RPC errors to the caller"],
    "indexer/src/rpc/getEvents.ts")

add("[INDEXER] Main polling loop with checkpointing",
    ["area:indexer", "P0"], MS_BACKEND,
    "The indexer must continuously poll, persist progress, and resume after restart.",
    "Implement the loop: load checkpoint → indexEvents(from) → save checkpoint → sleep "
    "POLL_INTERVAL_MS. On boot with no checkpoint, start from START_LEDGER.",
    ["Resumes from the last saved checkpoint after restart",
     "Configurable poll interval", "Loop survives a single iteration error (logs + continues)",
     "Clean shutdown on SIGINT/SIGTERM saves checkpoint"],
    "indexer/src/index.ts")

add("[INDEXER] Topic/value decoder utilities (scValToNative)",
    ["area:indexer", "P0"], MS_BACKEND,
    "Raw XDR event topics and values must be decoded to JS values consistently.",
    "Wrap `scValToNative` with helpers to decode an event's topics array and value into "
    "a typed `{ type, subtype, data }`.",
    ["Decodes topics and value", "Handles address, i128, bool, symbol, map types",
     "Unit tests with sample XDR fixtures"],
    "indexer/src/decode.ts")

# Per-event-type handlers
for ev, desc in [
    ("market_created", "a new market is created — insert into markets"),
    ("market_resolved", "a market is resolved — set resolved/outcome, invalidate caches"),
    ("market_cancelled", "a market is cancelled — set cancelled=true"),
    ("bet_placed", "a bet is placed — upsert bets, bump bet_count, update totals"),
    ("claim", "a winner claims — mark bet claimed"),
    ("reward_points", "points awarded — update leaderboard points"),
    ("token_mint", "IPRED tokens minted to a user — optional balance tracking"),
    ("referral_registered", "a referral relationship is registered"),
    ("referral_reward", "a referrer earns a reward"),
    ("fee_withdrawn", "admin withdraws accumulated fees"),
]:
    add(f"[INDEXER] Handler: {ev} event",
        ["area:indexer", "P0" if ev in ("market_created", "bet_placed", "market_resolved") else "P1"],
        MS_BACKEND,
        f"When {desc}.",
        f"Implement the decoder + DB write for the `{ev}` event topic. Validate fields, "
        "upsert the relevant table(s), and trigger cache invalidation where applicable.",
        ["Decodes the event's specific payload",
         "Writes/updates the correct table(s) idempotently",
         "Invalidates affected Redis keys (if any)",
         "Unit test with a sample event"],
        f"indexer/src/handlers/{ev}.ts")

add("[INDEXER] Handler dispatch registry",
    ["area:indexer", "P0"], MS_BACKEND,
    "A single place maps an event type to its handler.",
    "Implement a registry/dispatch that routes a decoded event to the right handler by topic.",
    ["Unknown event types are logged and skipped (not fatal)",
     "Adding a handler is one registry line", "Dispatch is unit-tested"],
    "indexer/src/handlers/index.ts")

add("[INDEXER] Idempotent event writes (dedupe on tx_hash + index)",
    ["area:indexer", "P0"], MS_BACKEND,
    "Re-polling overlapping ledgers must not double-count bets or duplicate rows.",
    "Ensure every write path is idempotent: dedupe events by (tx_hash, event_index) and "
    "use ON CONFLICT upserts so re-processing is safe.",
    ["Re-running the indexer over the same ledger range produces identical DB state",
     "Integration test replays a batch twice with no drift"],
    "indexer/src/handlers/")

add("[INDEXER] Historical backfill mode",
    ["area:indexer", "P1"], MS_BACKEND,
    "On first deploy we must index all history from the contract's first ledger.",
    "Add a backfill mode that pages from START_LEDGER to head as fast as RPC allows, "
    "then hands off to the live loop.",
    ["`--backfill` indexes from START_LEDGER to current head",
     "Respects RPC rate limits / retries on 429",
     "Transitions to live polling when caught up"],
    "indexer/src/backfill.ts")

add("[INDEXER] Ledger reorg / gap detection",
    ["area:indexer", "P1"], MS_BACKEND,
    "If the indexer falls behind RPC's event retention window we must detect the gap.",
    "Detect when startLedger is older than RPC's oldest retained ledger and surface a "
    "clear error + recovery path (re-backfill from snapshot).",
    ["Detects 'startLedger too old' RPC errors",
     "Logs a clear remediation message", "Does not silently skip ledgers"],
    "indexer/src/rpc/getEvents.ts")

add("[INDEXER] RPC retry with exponential backoff",
    ["area:indexer", "P0"], MS_BACKEND,
    "Public RPC nodes rate-limit and occasionally fail; the indexer must be resilient.",
    "Wrap RPC calls with retry + exponential backoff + jitter, capped, with 429 awareness.",
    ["Retries transient failures", "Backs off on 429", "Gives up after a cap and surfaces the error"],
    "indexer/src/rpc/retry.ts")

add("[INDEXER] Config loading + validation",
    ["area:indexer", "P0"], MS_BACKEND,
    "Misconfiguration should fail fast at boot, not mid-loop.",
    "Load and validate env (DATABASE_URL, SOROBAN_RPC_URL, contract IDs, intervals) with Zod.",
    ["Missing/invalid env fails boot with a clear message", "Typed config object exported"],
    "indexer/src/config/index.ts")

add("[INDEXER] Structured logging",
    ["area:indexer", "P1"], MS_BACKEND,
    "We need queryable logs for indexer lag and errors.",
    "Add structured (JSON) logging with levels and per-iteration summary (events processed, lag).",
    ["JSON logs with level + timestamp", "Per-poll summary line", "Configurable log level"],
    "indexer/src/log.ts")

add("[INDEXER] Expose indexer lag metric hook",
    ["area:indexer", "area:monitoring", "P1"], MS_MONITOR,
    "Monitoring needs to know how far behind head the indexer is.",
    "Compute `latestLedger - checkpoint` each poll and expose it for the metrics endpoint.",
    ["Lag computed each poll", "Exported for Prometheus collector"],
    "indexer/src/metrics.ts")

add("[INDEXER] Graceful shutdown & checkpoint flush",
    ["area:indexer", "P1"], MS_BACKEND,
    "On deploy/restart we must not lose or repeat work.",
    "Trap SIGINT/SIGTERM, finish the current event, flush checkpoint, close DB/Redis, exit 0.",
    ["No partial event left half-written", "Checkpoint saved before exit", "Connections closed"],
    "indexer/src/index.ts")

for n, (title, what) in enumerate([
    ("totals recomputation from bets", "Add a job to recompute market total_yes/total_no from bets as a consistency check."),
    ("bet_count backfill", "Add a maintenance task to recompute bet_count per market from the bets table."),
    ("leaderboard rebuild job", "Add a job that rebuilds the leaderboard table from the events log."),
    ("event payload schema validation", "Validate decoded event payloads against Zod schemas before writing."),
    ("dead-letter for undecodable events", "Persist events that fail to decode to a dead-letter table for inspection."),
    ("indexer dockerfile", "Write a multi-stage Dockerfile for the indexer."),
    ("indexer integration test harness", "Set up a test harness with a throwaway Postgres (testcontainers or compose)."),
    ("contract-id allowlist filter", "Make the indexed contract set configurable and validated."),
    ("poll-loop unit tests", "Unit-test the loop logic with a mocked RPC + DB."),
    ("metrics: events_processed counter", "Increment an events_processed counter per handled event."),
], start=1):
    ms = MS_TESTING if "test" in title else (MS_INFRA if "docker" in title else (MS_MONITOR if "metric" in title else MS_BACKEND))
    labels = ["area:indexer"]
    if "test" in title: labels.append("area:testing")
    if "docker" in title: labels.append("area:infra")
    if "metric" in title: labels.append("area:monitoring")
    labels.append("P1")
    add(f"[INDEXER] {title}", labels, ms,
        "Hardening and operational completeness for the indexer.",
        what,
        ["Implemented per description", "Covered by a test or documented runbook step"],
        "indexer/src/")


# ──────────────────────────────────────────────────────────────────────────────
# BACKEND API  (area:backend / area:api)  — ~55
# ──────────────────────────────────────────────────────────────────────────────
add("[API] Bootstrap Fastify server",
    ["area:backend", "P0"], MS_BACKEND,
    "Everything else hangs off a configured HTTP server.",
    "Replace the scaffold entry with a Fastify instance: logging, JSON, graceful shutdown, "
    "listen on PORT/HOST, health route `/healthz`.",
    ["Server starts and responds 200 on `/healthz`",
     "Reads PORT/HOST from config", "Graceful shutdown on SIGTERM"],
    "backend/src/server.ts")

add("[API] Config loading + validation (Zod)",
    ["area:backend", "P0"], MS_BACKEND,
    "Fail fast on misconfiguration.",
    "Load + validate all backend env vars with Zod; export a typed config.",
    ["Invalid env fails boot with a readable error", "Typed config exported", "No process.env reads outside config"],
    "backend/src/config/index.ts")

add("[API] Central error handler + error shape",
    ["area:backend", "P0"], MS_BACKEND,
    "Clients need consistent error responses; we must not leak stack traces.",
    "Implement a Fastify error handler returning `{ error: { code, message } }` with proper "
    "status codes; map known errors, hide internals on 500.",
    ["Consistent error JSON shape", "4xx vs 5xx mapped correctly", "No stack traces in responses"],
    "backend/src/lib/errors.ts")

add("[API] Request validation middleware (Zod schemas)",
    ["area:backend", "area:api", "P0"], MS_BACKEND,
    "Query/body params must be validated before hitting the DB.",
    "Provide a helper to validate request query/params/body against Zod and return 400 on failure.",
    ["Invalid query returns 400 with field errors", "Reusable across routes", "Typed handler input after validation"],
    "backend/src/lib/validate.ts")

# Markets endpoints
add("[API] GET /api/markets — list with filter/category/sort/pagination",
    ["area:api", "area:backend", "P0"], MS_BACKEND,
    "The primary endpoint the markets page calls.",
    "Implement GET /api/markets supporting filter=active|resolved|ended|cancelled, "
    "category, sort=newest|volume|ending_soon|bettors, page, limit. Return "
    "`{ markets, total, page }`.",
    ["All query params validated + defaulted", "Pagination correct (total reflects filter)",
     "Sort options work", "Reads from DB layer, not RPC", "Integration test covers filters"],
    "backend/src/api/markets.ts")

add("[API] GET /api/markets/:id — single market",
    ["area:api", "area:backend", "P0"], MS_BACKEND,
    "Market detail page needs one market by id.",
    "Implement GET /api/markets/:id returning the market or 404.",
    ["Returns the market", "404 for unknown id", "id validated as a positive integer"],
    "backend/src/api/markets.ts")

add("[API] GET /api/markets/:id/bets — paginated bets for a market",
    ["area:api", "area:backend", "P0"], MS_BACKEND,
    "Market detail shows recent bets.",
    "Implement GET /api/markets/:id/bets?page&limit returning `{ bets, total }`.",
    ["Pagination works", "404 if market missing", "Bets sorted newest-first"],
    "backend/src/api/markets.ts")

add("[API] GET /api/leaderboard — paginated leaderboard",
    ["area:api", "area:backend", "P0"], MS_BACKEND,
    "Leaderboard page + homepage preview.",
    "Implement GET /api/leaderboard?offset&limit&sort=points|bets returning `{ players, total }`.",
    ["Offset/limit validated", "Sort by points and by bets", "Reads from leaderboard table"],
    "backend/src/api/leaderboard.ts")

add("[API] GET /api/stats — global stats",
    ["area:api", "area:backend", "P0"], MS_BACKEND,
    "Homepage LiveStats needs aggregate numbers.",
    "Implement GET /api/stats returning totalMarkets, totalVolume, totalUsers, totalBets.",
    ["Returns all four metrics", "Backed by an efficient aggregate query", "Cacheable"],
    "backend/src/api/stats.ts")

add("[API] GET /api/profile/:address — user profile aggregate",
    ["area:api", "area:backend", "P1"], MS_BACKEND,
    "Profile page needs a user's bets, points, win/loss in one call.",
    "Implement GET /api/profile/:address aggregating bets + leaderboard entry for an address.",
    ["Validates Stellar address format (G..., 56 chars)", "Returns bets + points + win/loss",
     "404 or empty profile for unknown address (documented choice)"],
    "backend/src/api/profile.ts")

add("[API] POST /api/oracle/submit — provider submission intake",
    ["area:api", "area:oracle", "P1"], MS_OPTIMISTIC,
    "Oracle providers submit outcomes through the backend (auth + record + forward).",
    "Implement POST /api/oracle/submit { marketId, outcome, signature, provider } guarded by "
    "API-key auth; record the submission and return `{ accepted, submissionsNeeded }`.",
    ["Bearer/API-key auth enforced", "Body validated", "Submission recorded in oracle_submissions",
     "Returns remaining submissions to threshold"],
    "backend/src/api/oracle.ts")

# Cross-cutting API issues
for title, what, loc, ms, extra_labels in [
    ("Route registration + versioning (/api/v1)", "Register all routes under /api/v1 and add a route index.", "backend/src/api/index.ts", MS_BACKEND, []),
    ("CORS configuration", "Configure CORS to allow the frontend origin(s) only.", "backend/src/server.ts", MS_BACKEND, []),
    ("Security headers (helmet)", "Add standard security headers.", "backend/src/server.ts", MS_BACKEND, []),
    ("Request logging + request-id", "Log each request with a correlation id.", "backend/src/lib/log.ts", MS_BACKEND, []),
    ("OpenAPI / Swagger spec", "Generate and serve an OpenAPI spec at /api/docs.", "backend/src/api/openapi.ts", MS_BACKEND, ["area:docs"]),
    ("Standard pagination helper", "Shared offset/limit parsing + total-count envelope.", "backend/src/lib/pagination.ts", MS_BACKEND, []),
    ("Health: /readyz checks DB+Redis", "Readiness probe verifying DB and Redis connectivity.", "backend/src/api/health.ts", MS_INFRA, ["area:infra"]),
    ("Graceful shutdown drains in-flight requests", "Stop accepting, drain, then close.", "backend/src/server.ts", MS_BACKEND, []),
    ("404 + method-not-allowed handlers", "Consistent handling for unknown routes/methods.", "backend/src/lib/errors.ts", MS_BACKEND, []),
    ("Response compression", "gzip/br compression for list endpoints.", "backend/src/server.ts", MS_BACKEND, []),
    ("ETag / conditional GET for market lists", "Support ETag to cut payload on unchanged lists.", "backend/src/api/markets.ts", MS_CACHE, ["area:cache"]),
    ("API integration test setup", "Test harness booting the app against a test DB.", "backend/test/setup.ts", MS_TESTING, ["area:testing"]),
    ("Markets endpoint integration tests", "Cover filter/sort/pagination + 404.", "backend/test/markets.test.ts", MS_TESTING, ["area:testing"]),
    ("Leaderboard endpoint integration tests", "Cover sort + pagination.", "backend/test/leaderboard.test.ts", MS_TESTING, ["area:testing"]),
    ("Stats endpoint test", "Verify aggregate values against seeded data.", "backend/test/stats.test.ts", MS_TESTING, ["area:testing"]),
    ("Input fuzz/edge tests for pagination", "Negative/huge/non-numeric page & limit.", "backend/test/pagination.test.ts", MS_TESTING, ["area:testing"]),
    ("Backend Dockerfile", "Multi-stage Dockerfile for the API.", "backend/Dockerfile", MS_INFRA, ["area:infra"]),
    ("API error-rate metric hook", "Count 5xx responses for monitoring.", "backend/src/metrics.ts", MS_MONITOR, ["area:monitoring"]),
    ("Request-duration histogram", "Record per-route latency.", "backend/src/metrics.ts", MS_MONITOR, ["area:monitoring"]),
    ("Sanitize/normalize category param", "Map/validate category against the known set.", "backend/src/api/markets.ts", MS_BACKEND, []),
    ("Sort=volume backed by total_yes+total_no", "Implement volume sort correctly.", "backend/src/db/markets.ts", MS_BACKEND, ["area:db"]),
    ("Sort=ending_soon excludes resolved", "Ending-soon must ignore resolved/cancelled.", "backend/src/db/markets.ts", MS_BACKEND, ["area:db"]),
    ("Empty-state responses are well-formed", "Empty lists return {items:[],total:0} not null.", "backend/src/lib/pagination.ts", MS_BACKEND, []),
    ("Address normalization util", "Uppercase/validate G-addresses centrally.", "backend/src/lib/address.ts", MS_BACKEND, []),
    ("Amount formatting (stroops↔XLM) util", "Centralize 7-decimal conversions.", "backend/src/lib/amount.ts", MS_BACKEND, []),
    ("Config: per-route rate-limit table", "Encode the design-doc rate-limit table.", "backend/src/config/rateLimits.ts", MS_CACHE, ["area:cache"]),
    ("Frontend client: point app at backend API", "Add a feature-flagged data source in the frontend that reads the backend.", "frontend/src/services/api.ts", MS_BACKEND, []),
    ("Frontend: env flag NEXT_PUBLIC_USE_BACKEND", "Toggle between direct-RPC and backend reads.", "frontend/src/config/network.ts", MS_BACKEND, []),
    ("Contract test: API response shapes match frontend types", "Ensure API shapes match frontend Market/Bet types.", "backend/test/contract.test.ts", MS_TESTING, ["area:testing"]),
    ("Document all endpoints in backend/README", "Keep README endpoint list authoritative.", "backend/README.md", MS_BACKEND, ["area:docs"]),
]:
    labels = ["area:backend"] + extra_labels + ["P1"]
    add(f"[API] {title}", labels, ms,
        "Cross-cutting backend concern for a production-grade API.",
        what,
        ["Implemented per description", "Has a test or is exercised by an existing test", "No regression to existing endpoints"],
        loc)


# ──────────────────────────────────────────────────────────────────────────────
# CACHE  (area:cache)  — ~15
# ──────────────────────────────────────────────────────────────────────────────
add("[CACHE] Redis client module",
    ["area:cache", "P0"], MS_CACHE,
    "All caching goes through one configured Redis client.",
    "Create an ioredis client reading REDIS_URL with reconnect strategy and a typed get/set/del helper.",
    ["Single exported client", "Reconnect on drop", "Typed JSON get/set with TTL", "Graceful close"],
    "backend/src/cache/redis.ts")

add("[CACHE] Cache-aside helper (getOrSet)",
    ["area:cache", "P0"], MS_CACHE,
    "Endpoints should transparently cache reads.",
    "Implement `getOrSet(key, ttl, loader)` that returns cached value or computes+stores it.",
    ["Returns cached on hit", "Calls loader + stores on miss", "Stampede-safe (single-flight) or documented",
     "Unit tested with a fake redis"],
    "backend/src/cache/cacheAside.ts")

add("[CACHE] Cache keys + TTL table from design doc",
    ["area:cache", "P0"], MS_CACHE,
    "Keys/TTLs must match the design doc.",
    "Encode markets:all(30s), markets:active(15s), market:{id}(30s), leaderboard:top20(60s), "
    "stats:global(60s), bets:{id}(30s) as a typed key/TTL registry.",
    ["Centralized key builders", "TTLs match the doc", "No stringly-typed keys at call sites"],
    "backend/src/cache/keys.ts")

add("[CACHE] Wire markets endpoints through cache",
    ["area:cache", "area:api", "P1"], MS_CACHE,
    "Markets list/detail are the hottest reads.",
    "Use getOrSet for GET /api/markets and /api/markets/:id with the right keys/TTLs.",
    ["Cache hit avoids DB", "Correct keys per filter/category/page", "Hit/miss observable in logs/metrics"],
    "backend/src/api/markets.ts")

add("[CACHE] Wire leaderboard + stats through cache",
    ["area:cache", "area:api", "P1"], MS_CACHE,
    "Leaderboard and stats change slowly; cache them.",
    "Apply getOrSet to leaderboard and stats endpoints.",
    ["Both endpoints cached with doc TTLs", "Stale data bounded by TTL"],
    "backend/src/api/leaderboard.ts")

add("[CACHE] Invalidation API + event hooks",
    ["area:cache", "area:indexer", "P1"], MS_CACHE,
    "When the indexer writes updates, stale caches must be cleared.",
    "Expose invalidate(keys) and call it from indexer handlers: market created → markets:all/active; "
    "bet → market:{id}, markets:active; resolved → all market caches + leaderboard.",
    ["Invalidation helper exported", "Each relevant handler invalidates the right keys",
     "Integration test: write → cache cleared"],
    "backend/src/cache/invalidate.ts")

for title, what in [
    ("Rate limiter (Redis sliding window)", "Implement a per-IP sliding-window limiter in Redis."),
    ("Apply per-route rate limits", "Hook the limiter into routes using the rate-limit table."),
    ("Rate-limit headers (X-RateLimit-*)", "Return remaining/limit/reset headers."),
    ("Cache hit-rate metric", "Track and expose cache hit rate."),
    ("Negative caching for 404 markets", "Briefly cache misses to avoid DB hammering."),
    ("Cache key versioning / namespace", "Prefix keys with a version to allow bulk bust."),
    ("Graceful degradation when Redis down", "Fall back to DB when Redis is unavailable, log it."),
    ("Cache unit tests", "Test getOrSet, invalidation, and limiter logic."),
    ("Bets list caching", "Cache GET /api/markets/:id/bets with 30s TTL + invalidation."),
]:
    labels = ["area:cache"]
    if "metric" in title: labels.append("area:monitoring")
    if "test" in title: labels.append("area:testing")
    labels.append("P1")
    add(f"[CACHE] {title}", labels, MS_CACHE,
        "Caching/rate-limiting layer for scale.",
        what,
        ["Implemented per description", "Tested or exercised", "Documented in code"],
        "backend/src/cache/")


# ──────────────────────────────────────────────────────────────────────────────
# ORACLE — COUNCIL (Phase 1.5)  — ~25
# ──────────────────────────────────────────────────────────────────────────────
add("[ORACLE] Council aggregator service skeleton",
    ["area:oracle", "P0"], MS_COUNCIL,
    "Phase 1.5 uses a 4-of-7 council; an off-chain aggregator watches their submissions and "
    "fires the final on-chain resolution once threshold is met. Zero contract changes.",
    "Build the aggregator skeleton: load config (council members, threshold), connect to RPC/DB, "
    "run a loop over expired-unresolved markets.",
    ["Loads COUNCIL_SIZE/COUNCIL_THRESHOLD from config", "Lists expired unresolved markets",
     "Loop scaffold with clean shutdown"],
    "oracle/src/aggregator/index.ts")

add("[ORACLE] Track council member submissions per market",
    ["area:oracle", "P0"], MS_COUNCIL,
    "We must count how many council members have submitted which outcome.",
    "Persist each council member's submitted outcome per market and compute the current tally.",
    ["Per-market tally of yes/no by member", "No double-counting a member",
     "Tally readable by the finalizer"],
    "oracle/src/aggregator/tally.ts")

add("[ORACLE] Detect threshold reached (4-of-7) and select outcome",
    ["area:oracle", "P0"], MS_COUNCIL,
    "Finalization triggers only when ≥ threshold members agree.",
    "Implement logic that returns the agreed outcome when any side reaches COUNCIL_THRESHOLD, "
    "else null.",
    ["Returns outcome when threshold met", "Returns null below threshold",
     "Handles split votes (no premature finalize)", "Unit tested"],
    "oracle/src/aggregator/threshold.ts")

add("[ORACLE] Submit final resolve_market tx (council)",
    ["area:oracle", "area:contracts", "P0"], MS_COUNCIL,
    "Once threshold is met, the aggregator submits the on-chain resolution using a resolver key.",
    "Build, sign, and submit `resolve_market(caller, market_id, outcome)` from a configured "
    "resolver account; poll for confirmation; record result.",
    ["Builds + signs + submits the tx", "Idempotent (won't resolve an already-resolved market)",
     "Records tx hash + outcome", "Handles failure with retry/alert"],
    "oracle/src/submitter/resolveMarket.ts")

add("[ORACLE] Council member registry + config",
    ["area:oracle", "P0"], MS_COUNCIL,
    "We need the 7 council addresses and the resolver key wired safely.",
    "Load council member public keys and the resolver signing key from env/secret store; validate.",
    ["7 member keys validated", "Resolver secret loaded from env (never logged)",
     "Boot fails if misconfigured"],
    "oracle/src/config/council.ts")

for title, what in [
    ("Council submission CLI for members", "A CLI a council member runs to record their outcome for a market."),
    ("Conflicting-submission detection", "Flag markets where members disagree past a threshold."),
    ("Stuck-market detection (>6h past expiry)", "Alert when an expired market has no quorum after N hours."),
    ("Aggregator dry-run mode", "Run the full flow without submitting on-chain (for testing)."),
    ("Resolver key rotation support", "Allow swapping the resolver key without downtime."),
    ("Aggregator persistence of decisions", "Persist finalize decisions + tx hashes to oracle_submissions."),
    ("Replay protection for finalize", "Never submit two resolutions for one market."),
    ("Aggregator metrics (resolution lag)", "Expose hours-from-expiry-to-resolution."),
    ("Council flow integration test", "End-to-end test against a local/testnet contract."),
    ("Council runbook docs", "Document how council members submit and how aggregator finalizes."),
    ("Handle market cancellation path", "Aggregator must skip/!finalize cancelled markets."),
    ("Quorum config validation", "Threshold must be > half of size; validate at boot."),
    ("Backoff on RPC failure during submit", "Retry submit with backoff; alert on persistent failure."),
    ("Aggregator structured logging", "JSON logs of tallies and decisions."),
    ("Aggregator Dockerfile", "Containerize the aggregator service."),
    ("Aggregator config: poll interval", "Make the scan interval configurable."),
    ("Per-category resolver mapping (optional)", "Allow different resolver sets per category."),
    ("Safety: refuse finalize if data missing", "Don't finalize without recorded member submissions."),
    ("Notify on successful finalize", "Send a webhook/log when a market is finalized."),
    ("Audit export of council decisions", "Export decisions+tallies to CSV/JSON for audit."),
]:
    labels = ["area:oracle"]
    if "metric" in title: labels.append("area:monitoring")
    if "test" in title: labels.append("area:testing")
    if "docs" in title or "runbook" in title: labels.append("area:docs")
    if "Dockerfile" in title: labels.append("area:infra")
    labels.append("P1")
    add(f"[ORACLE] {title}", labels, MS_COUNCIL,
        "Council (Phase 1.5) resolution operational completeness.",
        what,
        ["Implemented per description", "Tested or covered by a runbook", "No path can finalize a market twice"],
        "oracle/src/aggregator/")


# ──────────────────────────────────────────────────────────────────────────────
# ORACLE — OPTIMISTIC (Phase 2)  — ~30  (contract + off-chain)
# ──────────────────────────────────────────────────────────────────────────────
add("[CONTRACTS] Optimistic oracle: new DataKey variants + state",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "Phase 2 adds bonded optimistic resolution to the prediction_market contract.",
    "Add storage for submissions (outcome, submitter, bond, timestamp), challenge state, and "
    "the OPEN→SUBMITTED→CHALLENGED→ESCALATED→FINALIZED state machine fields.",
    ["New DataKey variants compile", "State enum models the doc's lifecycle",
     "Existing tests still pass", "No storage collision with current keys"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] submit_outcome(market_id, outcome, bond)",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "Anyone can post an outcome with a bond to start the optimistic window.",
    "Implement `submit_outcome` that escrows SUBMITTER_BOND, records the submission, and starts "
    "the challenge window. Reject if already submitted/resolved.",
    ["Escrows the submitter bond", "Sets state SUBMITTED + window start",
     "Rejects double submission", "Emits an event", "Unit tested"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] challenge(market_id, bond)",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "A disputer can challenge within the window by posting a larger bond.",
    "Implement `challenge` requiring DISPUTER_BOND > submitter bond, within the window; moves "
    "state to CHALLENGED → ESCALATED.",
    ["Requires larger bond", "Only within challenge window", "Moves to escalated state",
     "Emits event", "Unit tested"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] finalize_unchallenged(market_id)",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "If unchallenged after the window, anyone can finalize the submitted outcome.",
    "Implement finalize that, after the window with no challenge, sets the market resolved to the "
    "submitted outcome and returns the submitter's bond.",
    ["Only after window elapsed", "Sets resolved+outcome", "Returns submitter bond",
     "Callable by anyone", "Unit tested"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] council_resolve_dispute(market_id, outcome)",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "Escalated disputes are settled by the dispute council vote.",
    "Implement council resolution that distributes bonds per the doc (winner gets bonds, 10% council "
    "fee from loser) and finalizes the market.",
    ["Council-gated", "Bond distribution matches the doc", "Council fee taken",
     "Finalizes market", "Unit tested"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] Bond constants + accounting",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "Bonds must be tracked and refunded/distributed exactly.",
    "Add SUBMITTER_BOND/DISPUTER_BOND constants and bond ledger entries; ensure no XLM is lost or "
    "double-spent across all paths.",
    ["Constants match the doc", "Every bond has a payout path", "Sum-in == sum-out invariant tested"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] Events for oracle lifecycle",
    ["area:contracts", "area:oracle", "P1"], MS_OPTIMISTIC,
    "The indexer/monitor watch submission/challenge/finalize events.",
    "Emit events for submission, challenge, escalation, finalization with relevant fields.",
    ["Each transition emits a typed event", "Fields match the indexer handlers", "Documented topics"],
    "contracts/prediction_market/src/")

add("[CONTRACTS] Tests for optimistic state machine",
    ["area:contracts", "area:testing", "P1"], MS_OPTIMISTIC,
    "The bonded flow is security-critical and needs thorough tests.",
    "Cover happy path (unchallenged finalize), challenged→council, invalid transitions, and bond math.",
    ["Unchallenged finalize tested", "Challenge→council tested", "Invalid transitions rejected",
     "Bond conservation asserted"],
    "contracts/prediction_market/src/test.rs")

for title, what in [
    ("Indexer handler: oracle submission event", "Index submit_outcome events into oracle_submissions."),
    ("Indexer handler: challenge event", "Index challenge events into oracle_disputes."),
    ("Indexer handler: finalize event", "Index finalize/resolution events and update markets."),
    ("Monitor: submission watcher", "Watch new submissions and surface them."),
    ("Monitor: challenge watcher", "Alert when a submission is challenged."),
    ("Monitor: dispute escalation watcher", "Alert when a dispute escalates to council."),
    ("Monitor: bond-below-minimum alert", "Alert if a bond is below the required minimum."),
    ("Monitor: council inactivity alert (48h)", "Alert when council hasn't acted in 48h."),
    ("Off-chain submitter for optimistic outcomes", "Service that posts outcomes+bonds from data adapters."),
    ("Challenge bot (defensive)", "Optional bot that challenges clearly-wrong submissions."),
    ("Bond balance/risk dashboard data", "Expose total bonded XLM and at-risk markets."),
    ("Optimistic flow integration test (off-chain)", "Drive submit→finalize via the off-chain services on testnet."),
    ("Dispute council membership config", "Configure and validate the dispute council set."),
    ("Optimistic oracle runbook", "Document submit/challenge/finalize operations."),
    ("Replay protection for off-chain submitter", "Never submit twice for the same market."),
    ("Timeout handling for escalated disputes", "Handle disputes that exceed the council window."),
    ("Bond refund reconciliation job", "Reconcile expected vs actual bond refunds."),
    ("Outcome confidence gating", "Only auto-submit when data confidence is high."),
    ("Optimistic config: windows + bonds", "Make challenge/dispute windows + bonds configurable."),
    ("Security review checklist for oracle", "A checklist PR template for oracle changes."),
    ("Metrics: oracle_submissions/disputes counters", "Expose submission/dispute counters."),
    ("Metrics: oracle_resolution_lag_h", "Expose hours from expiry to finalization."),
]:
    labels = ["area:oracle"]
    if title.startswith("Indexer"): labels.append("area:indexer")
    if "Monitor" in title or "alert" in title: labels.append("area:monitoring")
    if "Metrics" in title: labels.append("area:monitoring")
    if "test" in title: labels.append("area:testing")
    if "runbook" in title or "review checklist" in title: labels.append("area:docs")
    labels.append("P1")
    add(f"[ORACLE] {title}", labels, MS_OPTIMISTIC,
        "Phase 2 optimistic oracle off-chain + monitoring completeness.",
        what,
        ["Implemented per description", "Tested or covered by a runbook", "No double-submit / double-payout path"],
        "oracle/src/")


# ──────────────────────────────────────────────────────────────────────────────
# ORACLE — DATA ADAPTERS  — ~25
# ──────────────────────────────────────────────────────────────────────────────
add("[ORACLE] Data adapter interface + registry",
    ["area:oracle", "P1"], MS_DATA,
    "Each market category resolves from one or more data sources; we need a common interface.",
    "Define `DataAdapter` { id, supports(market), fetchOutcome(market): {outcome, confidence, raw} } "
    "and a registry that picks adapters per category.",
    ["Interface defined + documented", "Registry selects adapters by category",
     "Adapters are independently testable"],
    "oracle/src/adapters/index.ts")

add("[ORACLE] Outcome normalization + confidence model",
    ["area:oracle", "P1"], MS_DATA,
    "Different sources return different shapes; we normalize to a yes/no + confidence.",
    "Implement normalization that turns raw source data into a boolean outcome + confidence score, "
    "with a documented mapping per category.",
    ["Normalizes to {outcome, confidence}", "Confidence in [0,1]", "Unit tests per mapping"],
    "oracle/src/adapters/normalize.ts")

add("[ORACLE] Multi-source agreement / fallback",
    ["area:oracle", "P1"], MS_DATA,
    "Primary/secondary/tertiary sources must agree or fall back per the doc's source table.",
    "Implement logic that queries primary→secondary→tertiary and decides outcome when sources agree, "
    "else flags for manual review.",
    ["Falls back on primary failure", "Requires agreement or flags conflict",
     "Configurable per category"],
    "oracle/src/adapters/resolve.ts")

for src, cat, detail in [
    ("CoinGecko", "Crypto", "price/market-cap queries"),
    ("Binance", "Crypto", "ticker/price queries"),
    ("CoinMarketCap", "Crypto", "price fallback"),
    ("TheOddsAPI", "Sports", "game results/odds"),
    ("SportDataAPI", "Sports", "scores/results"),
    ("ESPN feed", "Sports", "results fallback"),
    ("Metaculus", "Politics", "forecast/resolution"),
    ("Polymarket feed", "Politics", "market resolution reference"),
    ("Reuters", "Politics", "news-based confirmation"),
]:
    add(f"[ORACLE] Adapter: {src} ({cat})",
        ["area:oracle", "P1"], MS_DATA,
        f"{cat} markets resolve from {src} ({detail}).",
        f"Implement a `{src}` adapter: client, rate-limit handling, map a market to a query, return "
        "a normalized outcome + confidence + raw payload.",
        ["Implements the DataAdapter interface", "Handles API errors/rate limits + retries",
         "Maps market → query correctly", "Unit test with a recorded fixture response"],
        f"oracle/src/adapters/{src.lower().replace(' ', '')}.ts")

for title, what in [
    ("API key management for adapters", "Load/validate all data-source API keys from env."),
    ("Adapter response caching", "Cache source responses briefly to cut quota usage."),
    ("Adapter rate-limit coordination", "Shared limiter across adapters per provider."),
    ("Market→query mapping schema", "Structured mapping stored per market (e.g. asset, threshold, date)."),
    ("Manual-review queue for low confidence", "Route low-confidence/conflicting outcomes to a review queue."),
    ("Adapter health checks", "Ping each source and report availability."),
    ("Adapter fixtures + replay tests", "Record real responses and test deterministically."),
    ("Sports: handle postponed/cancelled games", "Map postponed games to market cancellation."),
    ("Crypto: timezone/snapshot-time correctness", "Resolve price at the exact market deadline (UTC)."),
    ("Politics: conservative confidence gating", "Require higher agreement for political outcomes."),
    ("Adapter selection by market metadata", "Pick adapters from a market's category + tags."),
    ("Adapter error taxonomy + logging", "Classify source errors (auth/quota/network/data)."),
    ("Adapters runbook + source matrix docs", "Document each source, its limits, and mapping."),
]:
    labels = ["area:oracle"]
    if "test" in title or "fixtures" in title: labels.append("area:testing")
    if "docs" in title or "runbook" in title: labels.append("area:docs")
    if "health" in title: labels.append("area:monitoring")
    labels.append("P1")
    add(f"[ORACLE] {title}", labels, MS_DATA,
        "Data-adapter layer that feeds outcomes to the oracle.",
        what,
        ["Implemented per description", "Tested with fixtures where applicable", "Quota-safe"],
        "oracle/src/adapters/")


# ──────────────────────────────────────────────────────────────────────────────
# INFRA  (area:infra)  — ~15
# ──────────────────────────────────────────────────────────────────────────────
for title, what, loc in [
    ("Production docker-compose (api/indexer/pg/redis)", "Write docker-compose.production.yml with replicated api, single indexer, postgres, redis per the doc.", "infra/docker-compose.production.yml"),
    ("Oracle services in compose", "Add aggregator/monitor services to production compose.", "infra/docker-compose.production.yml"),
    ("Centralized .env loading + secrets doc", "Document required env across all services + secret handling.", "infra/README.md"),
    ("Postgres backup/restore scripts", "Scripts for pg_dump backup + restore.", "infra/scripts/backup.sh"),
    ("Redis persistence config", "Configure AOF/RDB persistence appropriately.", "infra/redis.conf"),
    ("Healthcheck wiring for all services", "Add container healthchecks + depends_on conditions.", "infra/docker-compose.production.yml"),
    ("Reverse proxy / TLS termination", "Add nginx/caddy in front of the API with TLS.", "infra/proxy/"),
    ("Resource limits + restart policies", "Set memory/cpu limits and restart=always.", "infra/docker-compose.production.yml"),
    ("Migration step in deploy flow", "Run DB migrations before starting api/indexer.", "infra/scripts/deploy.sh"),
    ("Log aggregation config", "Ship container logs to a central sink.", "infra/logging/"),
    ("Staging environment compose", "A staging compose pointing at testnet.", "infra/docker-compose.staging.yml"),
    ("Secrets via env-file / vault placeholder", "Wire a secrets source (env-file now, vault later).", "infra/README.md"),
    ("Indexer single-instance lock", "Ensure only one indexer runs (advisory lock).", "indexer/src/lock.ts"),
    ("Container image tagging convention", "Document/set image tag scheme.", "infra/README.md"),
    ("Local make/justfile for common tasks", "Add a task runner for up/migrate/seed/test.", "Justfile"),
]:
    labels = ["area:infra", "P1"]
    if "migration" in title.lower() or "indexer" in title.lower(): labels.insert(1, "area:db" if "migration" in title.lower() else "area:indexer")
    add(f"[INFRA] {title}", labels, MS_INFRA,
        "Infrastructure for running the backend stack reliably.",
        what,
        ["Implemented per description", "Brought up cleanly with `docker compose up`", "Documented in infra/README.md"],
        loc)


# ──────────────────────────────────────────────────────────────────────────────
# MONITORING  (area:monitoring)  — ~15
# ──────────────────────────────────────────────────────────────────────────────
for title, what, loc in [
    ("Prometheus metrics endpoint (backend)", "Expose /metrics on the API with default + custom metrics.", "backend/src/metrics.ts"),
    ("Prometheus metrics endpoint (indexer)", "Expose indexer metrics (lag, events, rpc errors).", "indexer/src/metrics.ts"),
    ("Prometheus metrics endpoint (oracle)", "Expose oracle metrics (submissions, disputes, lag).", "oracle/src/metrics.ts"),
    ("Metric: indexer_lag_ledgers gauge", "Implement the indexer lag gauge.", "indexer/src/metrics.ts"),
    ("Metric: rpc_errors_total counter", "Count RPC failures across services.", "indexer/src/metrics.ts"),
    ("Metric: cache_hit_rate gauge", "Compute and expose cache hit rate.", "backend/src/metrics.ts"),
    ("Metric: api_request_duration histogram", "Per-route latency histogram.", "backend/src/metrics.ts"),
    ("Business metrics counters", "markets_created/bets_placed/volume/resolved counters.", "backend/src/metrics.ts"),
    ("Grafana dashboard: system health", "Dashboard JSON for indexer/api/db/redis health.", "infra/grafana/system.json"),
    ("Grafana dashboard: business metrics", "Dashboard for markets/bets/volume.", "infra/grafana/business.json"),
    ("Grafana dashboard: oracle health", "Dashboard for submissions/disputes/lag.", "infra/grafana/oracle.json"),
    ("Alert rules (Prometheus)", "Encode IndexerStalled/HighRPCErrorRate/MarketStuck/HighAPILatency/DatabaseSlow.", "infra/prometheus/alerts.yml"),
    ("Alerting receiver (webhook/Slack)", "Route alerts to a webhook/Slack channel.", "infra/alertmanager.yml"),
    ("Prometheus scrape config", "Scrape config for all service /metrics endpoints.", "infra/prometheus/prometheus.yml"),
    ("Uptime/synthetic check for API", "External check hitting /healthz + a real endpoint.", "infra/monitoring/synthetic.md"),
]:
    labels = ["area:monitoring", "P1"]
    if "Grafana" in title or "Alert" in title or "Prometheus scrape" in title or "synthetic" in title: labels.insert(1, "area:infra")
    add(f"[MONITORING] {title}", labels, MS_MONITOR,
        "Observability so we can run the backend in production safely.",
        what,
        ["Implemented per description", "Renders/scrapes correctly in a local Prometheus/Grafana",
         "Documented in infra/README.md"],
        loc)


# ──────────────────────────────────────────────────────────────────────────────
# TESTING  (area:testing)  — ~20
# ──────────────────────────────────────────────────────────────────────────────
for title, what, loc, ms in [
    ("Vitest config for backend", "Add vitest config + scripts for the backend package.", "backend/vitest.config.ts", MS_TESTING),
    ("Vitest config for indexer", "Add vitest config for the indexer.", "indexer/vitest.config.ts", MS_TESTING),
    ("Vitest config for oracle", "Add vitest config for the oracle.", "oracle/vitest.config.ts", MS_TESTING),
    ("Test DB bootstrap (ephemeral Postgres)", "Spin up an ephemeral Postgres for integration tests.", "backend/test/db.ts", MS_TESTING),
    ("Test Redis bootstrap", "Provide a fake/ephemeral Redis for tests.", "backend/test/redis.ts", MS_TESTING),
    ("Fixtures: sample decoded events", "Recorded event fixtures for indexer handler tests.", "indexer/test/fixtures/", MS_TESTING),
    ("Indexer handler unit tests (all events)", "Unit-test every event handler against fixtures.", "indexer/test/handlers.test.ts", MS_TESTING),
    ("Idempotency replay test", "Replay a ledger batch twice; assert no drift.", "indexer/test/replay.test.ts", MS_TESTING),
    ("Backend query-layer unit tests", "Test each DB query function.", "backend/test/db.test.ts", MS_TESTING),
    ("Cache layer unit tests", "Test getOrSet, invalidation, limiter.", "backend/test/cache.test.ts", MS_TESTING),
    ("API e2e smoke test", "Boot the API and hit each endpoint once.", "backend/test/e2e.test.ts", MS_TESTING),
    ("Oracle threshold logic tests", "Unit-test council threshold/outcome selection.", "oracle/test/threshold.test.ts", MS_TESTING),
    ("Oracle adapter fixture tests", "Test adapters against recorded responses.", "oracle/test/adapters.test.ts", MS_TESTING),
    ("Load test script (markets list)", "k6/autocannon script for the hot endpoint.", "backend/test/load/markets.js", MS_TESTING),
    ("Contract: optimistic oracle rust tests", "Rust tests for the optimistic state machine.", "contracts/prediction_market/src/test.rs", MS_TESTING),
    ("Test coverage reporting", "Add coverage output to each package's test run.", "backend/vitest.config.ts", MS_TESTING),
    ("Error-path tests (DB/Redis down)", "Assert graceful degradation when deps are down.", "backend/test/resilience.test.ts", MS_TESTING),
    ("Address/amount util tests", "Unit-test address + stroop/XLM utilities.", "backend/test/utils.test.ts", MS_TESTING),
    ("Pagination edge-case tests", "Negative/huge/non-numeric inputs.", "backend/test/pagination.test.ts", MS_TESTING),
    ("Seed-data verification test", "Assert seed script produces expected rows.", "db/test/seed.test.ts", MS_TESTING),
]:
    labels = ["area:testing"]
    if "indexer" in loc: labels.append("area:indexer")
    elif "oracle" in loc: labels.append("area:oracle")
    elif "contracts" in loc: labels.append("area:contracts")
    elif loc.startswith("db/"): labels.append("area:db")
    else: labels.append("area:backend")
    labels.append("P1")
    add(f"[TEST] {title}", labels, ms,
        "Test coverage so contributors can refactor safely and we can ship confidently.",
        what,
        ["Test(s) implemented per description", "Pass locally with `npm test`", "Deterministic (no flakiness)"],
        loc)


# ──────────────────────────────────────────────────────────────────────────────
# DOCS  (area:docs)  — ~10
# ──────────────────────────────────────────────────────────────────────────────
for title, what, loc in [
    ("API reference (endpoints, params, responses)", "Write a complete API reference for all endpoints.", "docs/API.md"),
    ("Indexer operations runbook", "How to run, backfill, recover, and monitor the indexer.", "docs/INDEXER_RUNBOOK.md"),
    ("Oracle operations runbook", "Council + optimistic operations end to end.", "docs/ORACLE_RUNBOOK.md"),
    ("Local development guide", "One-page guide to run the whole stack locally.", "docs/LOCAL_DEV.md"),
    ("Deployment guide (backend stack)", "Deploy api/indexer/oracle/db/redis to production.", "docs/BACKEND_DEPLOYMENT.md"),
    ("Database schema reference", "Authoritative schema doc with ER diagram.", "docs/DB_SCHEMA.md"),
    ("Architecture diagram (current vs target)", "Update ARCHITECTURE.md with the backend/oracle target.", "docs/ARCHITECTURE.md"),
    ("Contributor onboarding (where to start)", "A guided path through good starting issues.", "docs/ONBOARDING.md"),
    ("Security considerations doc", "Threat model for backend + oracle (keys, bonds, RPC trust).", "docs/SECURITY_BACKEND.md"),
    ("Glossary of terms", "Define market/bet/outcome/bond/council/etc.", "docs/GLOSSARY.md"),
]:
    add(f"[DOCS] {title}", ["area:docs", "P2"], MS_BACKEND,
        "Clear docs so contributors don't get stuck.",
        what,
        ["Document written and linked from README/CONTRIBUTING", "Accurate to the current code", "Renders cleanly on GitHub"],
        loc)


# ──────────────────────────────────────────────────────────────────────────────
# EXTRA  — round out to 260 with genuinely useful cross-cutting work
# ──────────────────────────────────────────────────────────────────────────────
add("[BACKEND] Shared `@ipredict/shared` types package",
    ["area:backend", "P1"], MS_BACKEND,
    "Backend, indexer, oracle, and frontend all need the same Market/Bet/event types.",
    "Create a small internal shared package exporting common TS types + enums (categories, event "
    "topics) consumed by all Node services.",
    ["Package builds and is importable by backend/indexer/oracle",
     "Single source of truth for shared types", "No circular deps"],
    "shared/")

add("[BACKEND] Root workspace wiring (npm workspaces)",
    ["area:backend", "area:infra", "P1"], MS_BACKEND,
    "Installing/building each service separately is tedious; wire a workspace.",
    "Add a root package.json with npm workspaces for backend/indexer/oracle/shared so a single "
    "`npm install` bootstraps all.",
    ["`npm install` at root installs all services", "Per-service scripts still work",
     "Documented in CONTRIBUTING.md"],
    "package.json (root)")

add("[INDEXER] Token contract balance tracking (optional table)",
    ["area:indexer", "area:db", "P2"], MS_BACKEND,
    "Profile pages may show IPRED balances; track mint/transfer events.",
    "Optionally index token mint/transfer events into a `token_balances` table.",
    ["Decides + documents whether to track on-chain or via SAC", "If tracked, balances stay consistent"],
    "indexer/src/handlers/token.ts")

add("[API] GET /api/markets/:id/odds — derived odds endpoint",
    ["area:api", "area:backend", "P2"], MS_BACKEND,
    "Frontend shows YES/NO odds derived from pool totals.",
    "Add an endpoint returning derived odds/implied probability from total_yes/total_no.",
    ["Returns yes/no implied probabilities", "Handles zero-pool gracefully", "Tested"],
    "backend/src/api/markets.ts")

add("[ORACLE] Outcome explanation / provenance record",
    ["area:oracle", "P2"], MS_DATA,
    "For trust, store why an outcome was chosen (which sources, values).",
    "Persist a provenance record per resolved market: sources queried, raw values, decision.",
    ["Provenance stored per resolution", "Retrievable for audit/display", "No secrets in provenance"],
    "oracle/src/adapters/provenance.ts")

add("[MONITORING] Status page data feed",
    ["area:monitoring", "area:backend", "P2"], MS_MONITOR,
    "A public status feed builds user trust.",
    "Expose a small JSON status feed (indexer lag, last resolved market, API health) for a status page.",
    ["Single endpoint summarizing health", "No sensitive data", "Cacheable"],
    "backend/src/api/status.ts")

add("[TEST] CI-less local verify script (typecheck+test all)",
    ["area:testing", "area:infra", "P1"], MS_TESTING,
    "With no CI on this branch, contributors need one command to self-check before PR.",
    "Add a `verify` script that runs typecheck + tests across all Node services.",
    ["One command checks backend+indexer+oracle", "Non-zero exit on any failure",
     "Documented in CONTRIBUTING.md"],
    "scripts/verify-all.sh")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print titles + counts only")
    ap.add_argument("--sample", type=int, default=0, help="create only the first N issues")
    args = ap.parse_args()

    total = len(ISSUES)
    # counts by primary area label
    from collections import Counter
    by_area = Counter()
    for _, labels, _, _ in ISSUES:
        area = next((l for l in labels if l.startswith("area:")), "area:?")
        by_area[area] += 1

    print(f"TOTAL ISSUES: {total}")
    for area, c in sorted(by_area.items()):
        print(f"  {area:18} {c}")
    print()

    if args.dry_run:
        for i, (title, labels, ms, _) in enumerate(ISSUES, 1):
            print(f"{i:3}. {title}   [{','.join(labels)}] ms={ms}")
        return

    # fetch existing titles to skip duplicates
    existing = set()
    try:
        out = subprocess.run(
            ["gh", "issue", "list", "--repo", REPO, "--state", "all",
             "--limit", "1000", "--json", "title"],
            capture_output=True, text=True, check=True).stdout
        existing = {x["title"] for x in json.loads(out)}
    except Exception as e:
        print(f"warn: could not fetch existing issues: {e}", file=sys.stderr)

    to_create = ISSUES[: args.sample] if args.sample else ISSUES
    created = skipped = failed = 0
    for i, (title, labels, ms, bdy) in enumerate(to_create, 1):
        if title in existing:
            print(f"skip (exists): {title}")
            skipped += 1
            continue
        cmd = ["gh", "issue", "create", "--repo", REPO, "--title", title,
               "--body", bdy, "--milestone", str(ms)]
        for l in labels:
            cmd += ["--label", l]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            print(f"[{i}/{len(to_create)}] created: {title}  -> {r.stdout.strip()}")
            created += 1
        else:
            print(f"FAIL: {title}\n  {r.stderr.strip()}", file=sys.stderr)
            failed += 1
        time.sleep(0.6)

    print(f"\n---- created={created} skipped={skipped} failed={failed} ----")


if __name__ == "__main__":
    main()
