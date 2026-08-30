# iPredict — Backend & Oracle Security Considerations

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

> **Scope:** this is a threat model for the off-chain backend stack — the API
> (`backend/`), indexer (`indexer/`), oracle services (`oracle/`),
> PostgreSQL, and Redis — covering key custody, bond mechanics, and RPC
> trust. It does not cover the Soroban contract audit; see
> [`AUDIT_AND_SCALE_REPORT.md`](AUDIT_AND_SCALE_REPORT.md) for that. Deploy
> steps referenced here are in [`BACKEND_DEPLOYMENT.md`](BACKEND_DEPLOYMENT.md).

## Key inventory

Every secret in the stack, which service holds it, and what it is
deliberately excluded from. This mirrors
["Configuration and secrets" in `infra/README.md`](../infra/README.md#configuration-and-secrets).

| Secret | Reaches | Deliberately excluded from | Purpose |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | `postgres`, and every service's composed `DATABASE_URL` | — | Database auth |
| `REDIS_PASSWORD` | `redis`, and every service's composed `REDIS_URL` | `indexer`'s Postgres-only peers use it too, but the password itself never reaches a service that doesn't talk to Redis | Cache/rate-limiter auth |
| `ORACLE_API_KEY` | `api` | `indexer`, `oracle-aggregator`, `oracle-monitor` | Guards `POST /api/v1/oracle/submit` |
| `RESOLVER_KEY` | `oracle-aggregator` | `api`, `indexer`, **`oracle-monitor`** | Signs `resolve_market` transactions |
| Adapter API keys (`COINGECKO_API_KEY`, `COINMARKETCAP_API_KEY`, `SPORTDATA_API_KEY`, `THE_ODDS_API_KEY`, `METACULUS_API_KEY`) | `oracle-aggregator` | everything else | Data-source auth for outcome resolution |

The `oracle-aggregator` / `oracle-monitor` split exists specifically for key
custody: the aggregator *writes* (it holds `RESOLVER_KEY` and can submit
transactions), the monitor only reads Postgres and posts alerts, so it is
given no signing credential at all. A compromised or crash-looping monitor
cannot resolve markets; a compromised aggregator's blast radius is bounded to
what `RESOLVER_KEY` can do on-chain.

Secret handling rules (enforced by convention, not by tooling):

- **Never commit `.env`.** It is covered by the root `.gitignore`; only
  `.env.example` (with blank or `CHANGE_ME_*` placeholders) is tracked.
- **Generate, do not invent.** `openssl rand -base64 24` for passwords,
  `openssl rand -hex 32` for API keys.
- **`chmod 600 infra/.env`** on the deployment host — it holds the key for an
  account that can resolve markets.
- **Never log a secret.** `infra/scripts/restore.sh` redacts the password out
  of connection strings before printing them, and the Redis health check
  reads `REDISCLI_AUTH` from the environment so the password never appears in
  the container process list.
- **Rotation.** Postgres/Redis passwords: update `.env`, then
  `docker compose -f docker-compose.production.yml up -d --force-recreate`.
  `RESOLVER_KEY` rotates through `oracle/src/aggregator/key-rotation.ts`
  (`ResolverKeyManager`) — rotate the on-chain resolver first, then the file.
  Rotation keeps the previous key valid during a grace period
  (`pendingKeys`) so in-flight transactions signed with it still land, then
  `revokePending()` once the transition is confirmed complete.

### Known gap: `ORACLE_API_KEY` has an insecure default

`backend/src/api/oracle.ts` falls back to the literal string
`"test-oracle-api-key"` when `ORACLE_API_KEY` is unset. In production this
means the oracle submission endpoint is either correctly guarded by a real
key, or — if the operator forgets to set it — guarded by a publicly-known
constant, not disabled. This is why `ORACLE_API_KEY` is one of the compose
`${VAR:?message}` required variables (see
[`BACKEND_DEPLOYMENT.md`](BACKEND_DEPLOYMENT.md#step-1-configure-secrets)):
Compose refuses to start rather than silently accepting the default.

## Bond mechanics (economic security)

The optimistic oracle (implemented in
`contracts/prediction_market/src/lib.rs`, described in
["Optimistic Oracle Contract API"](ORACLE_AND_BACKEND.md#optimistic-oracle-contract-api))
uses bonded submissions instead of a signature-only trust model:

- A submitter escrows `SUBMITTER_BOND` (100 XLM minimum) to propose an
  outcome via `submit_outcome`.
- A challenger must escrow `DISPUTER_BOND` (200 XLM minimum, and strictly
  greater than the submitter's bond) to dispute it via `challenge`, within
  the `CHALLENGE_WINDOW` (24h).
- An unchallenged submission finalizes automatically after the window and
  returns the bond in full — no fee is taken, since nothing was contested.
- A challenged submission escalates to the council, which rules within
  `COUNCIL_WINDOW` (72h). The losing side forfeits its bond: the winner
  recovers their own bond plus half the loser's, and `COUNCIL_FEE_BPS`
  (10%) of the loser's bond is credited to `AccumulatedFees`.

This makes a false submission costly (loses the bond) and a frivolous
challenge equally costly, so the bond sizes must stay meaningfully above gas
cost and expected market value to deter griefing. If a market is cancelled
or force-resolved while a submission is open, the finalizers still run so
bonds are never permanently stranded in escrow.

**Operational risk:** bond amounts (`SUBMITTER_BOND_XLM`,
`DISPUTER_BOND_XLM`) are configured off-chain in `infra/.env` and read by the
aggregator; the on-chain contract constants
(`SUBMITTER_BOND: i128 = 100_0000000`) are the actual enforced minimum.
Raising the off-chain default without a matching contract constant only
changes what the aggregator itself is willing to submit — it does not raise
the floor other submitters can post at.

## Council trust model

Before the optimistic oracle, and as its escalation path, resolution goes
through a 4-of-7 council: `COUNCIL_MEMBERS` (public keys) each submit a vote,
recorded one row per `(market_id, member)` in `council_votes`
(see [`DB_SCHEMA.md`](DB_SCHEMA.md#council_votes)), and the aggregator's
tally (`oracle/src/aggregator/tally.ts`) finalizes once `COUNCIL_THRESHOLD`
(default 4 of 7) agree. This is a **trusted-committee model** — see
["Single Admin Key Controls Everything"](AUDIT_AND_SCALE_REPORT.md) in the
contract audit for the related on-chain risk before a council of resolvers is
registered. Threats specific to the off-chain council tally:

- **Vote replay / double-count** — mitigated by the `(market_id, member)`
  primary key: a member's vote can be updated but never counted twice.
- **Minority stall** — `MIN_REQUIRED_SUBMISSIONS` prevents finalizing on an
  incomplete quorum; `oracle-monitor` raises
  `oracle.monitor.council_inactive` if an escalated market gets no votes
  within `COUNCIL_INACTIVITY_HOURS`, and
  `oracle.monitor.council_window_exceeded` if it passes the 72h window
  entirely.
- **Conflicting submissions** — `CONFLICT_THRESHOLD` (fraction of dissenting
  votes) flags disagreement for operator attention rather than silently
  taking a bare majority.

## RPC trust

The indexer and oracle both depend on `SOROBAN_RPC_URL` for ground truth —
the indexer polls `getEvents()` to build the database the API serves from,
and the oracle aggregator/submitter read contract state before submitting
transactions.

- **Single RPC endpoint is a single point of failure/trust.** A malicious or
  compromised RPC provider could return stale or incorrect event data;
  nothing in the indexer independently verifies event authenticity beyond
  what the RPC node reports. Use a provider you trust, and prefer one with
  its own redundancy (the stack does not run multiple RPC providers with
  cross-checking).
- **Passphrase/contract-ID mismatch fails at signing time, not startup** — a
  testnet `NETWORK_PASSPHRASE` paired with mainnet contract IDs (or vice
  versa) is not caught until a transaction is rejected. Both are required
  variables so the stack refuses to boot at all if either is missing, but a
  *wrong* value for one is not independently validated against the other.
- **Rate limits.** Public RPC nodes throttle around 50 req/s per IP; this is
  the original motivation for the indexer + Postgres + Redis architecture
  documented in ["Why a Backend Is Needed"](ORACLE_AND_BACKEND.md#why-a-backend-is-needed).
  `rpc/retry.ts` backs off on transient failures; sustained throttling shows
  up as `rpc_errors_total` and trips the `HighRPCErrorRate` alert.
- **Indexer stalls are observable, not silent.** `indexer_lag_ledgers`
  (gauge) and the `IndexerStalled` alert
  (`indexer_lag_ledgers > 100`, see [`infra/prometheus/alerts.yml`](../infra/prometheus/alerts.yml))
  catch an RPC endpoint that stops returning fresh events.

## API surface hardening

The backend API (`backend/`) is the only service exposed to untrusted
traffic. Its defenses, from [`backend/README.md`](../backend/README.md#api-hardening):

- **CORS** — allowlist only, from `CORS_ORIGINS`. Unset falls back to
  `http://localhost:3000` (dev default); an empty value allows no browser
  origin at all. Non-browser callers (curl, service-to-service, health
  checks) are unaffected since they send no `Origin` header. A disallowed
  origin still gets a normal response — just with no CORS headers — which is
  what makes the browser (not the server) block the read.
- **Security headers** — `@fastify/helmet` with `default-src 'none'`,
  `frame-ancestors 'none'`, HSTS, and `Referrer-Policy: no-referrer`.
- **Rate limiting** — per-IP, Redis-backed sliding window, configured per
  route in `backend/src/config/rateLimits.ts` (`RATE_LIMIT_DEFAULT`,
  `RATE_LIMIT_WINDOW_SECONDS`).
- **Errors never leak internals** — every failure, including unknown routes,
  returns one envelope shape (`{ "error": { "code", "message" } }`); a 500
  does not echo a stack trace or query text to the client.
- **Request correlation** — every request gets a structured log line with a
  correlation id, echoed in `x-request-id`, so an incident can be traced
  end-to-end without exposing anything to the caller beyond the id itself.

## Data trust: adapters and confidence

Oracle data adapters (`oracle/src/adapters/`) pull outcome data from external
providers (CoinGecko, Binance, TheOddsAPI, Reuters, Polymarket feed, …).
Each result carries a `confidence` score; only results at or above the
adapter's threshold are used to submit an outcome, and adapters without a
configured API key fall back to the provider's unauthenticated endpoint,
which is more aggressively rate-limited and a weaker trust source than an
authenticated one. Treat data-source outages as a resolution risk, not just
an availability one: a provider serving degraded or manipulated data with
high self-reported confidence is not caught by rate-limit handling alone —
this is why the council/challenge path exists as a check on any single
automated submission.

## Idempotency and double-submission safety

Every durable write in the oracle path is guarded against re-processing after
a crash or restart:

- The indexer's checkpoint plus the `(tx_hash, event_index)` unique index on
  `events` (see [`DB_SCHEMA.md`](DB_SCHEMA.md#events)) makes event replay
  safe — a re-processed event is rejected by the constraint rather than
  double-applied.
- `submitter/resolveMarket.ts` checks `isAlreadyResolved` before submitting,
  so a retried submission attempt cannot double-submit.
- The indexer's Postgres advisory lock (`indexer/src/lock.ts`) ensures
  exactly one indexer instance writes at a time; a second instance fails
  fast with `IndexerAlreadyRunningError` instead of racing the first.

See `oracle/src/ORACLE_SECURITY_CHECKLIST.md` for the PR-time checklist these
properties are reviewed against for any change under `oracle/`.

## Reporting a vulnerability

The repository does not yet publish a dedicated security contact. For a
finding that would be safe to discuss publicly (a hardening gap, a missing
validation), open a GitHub issue labeled `area:security` following the
process in [`CONTRIBUTING.md`](../CONTRIBUTING.md). For a finding that is
directly exploitable against the live deployment (a way to forge an oracle
submission, drain a bond, or obtain a key), do not open a public issue —
contact a repository maintainer directly through GitHub instead.
