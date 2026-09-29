# iPredict — Glossary

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

Definitions of the domain and system terms used across the contracts,
backend, indexer, and oracle. Terms are grouped by area; each entry links to
the doc that covers it in depth.

## Market

- **Market** — A single prediction question (e.g. "Will BTC hit $100k?") with
  a `question`, `category`, `end_time`, and two sides (YES/NO). Created via
  `create_market` on `contracts/prediction_market`.
- **Outcome** — The boolean result of a market once resolved: `true` for YES,
  `false` for NO.
- **Resolve / Resolution** — The act of setting a market's final outcome,
  either by an admin/resolver (current model) or by the oracle workflow
  described in [`ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md).
- **Cancel / Cancellation** — Marking a market as void instead of resolved,
  refunding bettors instead of paying out a winning side.
- **Bet** — A user's stake on one side (YES or NO) of a market. Stored per
  `(market_id, bettor)` — see the `bets` table in
  [`DB_SCHEMA.md`](DB_SCHEMA.md#bets).
- **Claim** — A bettor withdrawing their payout from a resolved market they
  won, or their refund from a cancelled market.
- **Total YES / Total NO** — The aggregated stake on each side of a market,
  used to compute odds and payouts.

## Oracle & resolution

- **Oracle** — The system that determines a market's real-world outcome and
  submits it on-chain. iPredict's oracle has two phases described in
  [`ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md): a **council** model
  (Phase 1.5, implemented) and an **optimistic oracle** model (Phase 2,
  implemented on the contract, described in the same doc).
- **Council** — A fixed set of trusted addresses (`COUNCIL_MEMBERS`,
  `COUNCIL_SIZE` of them, default 7) who each submit their view of a market's
  outcome. Once `COUNCIL_THRESHOLD` (default 4) agree, the aggregator
  finalizes the resolution on-chain. See `oracle/src/aggregator/`.
- **Council vote / submission** — One council member's outcome for a market,
  recorded in the `council_votes` table
  (see [`DB_SCHEMA.md`](DB_SCHEMA.md#council_votes)).
- **Tally** — The de-duplicated count of council votes (one per member,
  latest wins) used to decide whether the agreement threshold is met. See
  `oracle/src/aggregator/tally.ts`.
- **Resolver** — The Stellar address authorized to call `resolve_market` on
  the prediction market contract. In the council model, the aggregator signs
  with the **resolver key** on the council's behalf once threshold is met.
- **Submitter / Submission** — In the optimistic oracle, the party (anyone)
  who posts a proposed outcome plus a bond via `submit_outcome`. Tracked in
  `oracle_submissions` (see [`DB_SCHEMA.md`](DB_SCHEMA.md#oracle_submissions)).
- **Challenge / Disputer** — In the optimistic oracle, anyone who disagrees
  with a submitted outcome can post a larger bond via `challenge` within the
  challenge window, escalating the market to the council.
- **Bond** — XLM escrowed by a submitter (`SUBMITTER_BOND`, 100 XLM) or
  challenger (`DISPUTER_BOND`, 200 XLM) to back their claimed outcome.
  Bonds are settled on finalization: the correct party recovers their bond
  plus a share of the loser's, minus the council fee. See
  ["Bond Mechanics" in `ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md#bond-mechanics).
- **Council fee** — The percentage (`COUNCIL_FEE_BPS`, default 10%) of the
  losing bond credited to the protocol's accumulated fees when the council
  rules on a disputed outcome.
- **Finalize / Finalization** — The step that sets the market's on-chain
  outcome and settles any escrowed bonds, via `finalize_outcome` (unchallenged
  path) or `resolve_challenge` (council ruling path).
- **Escalated** — The state of an optimistic-oracle submission after it has
  been challenged and is now awaiting a council ruling.
- **Resolver key rotation** — Replacing the active resolver signing key
  without downtime, keeping the previous key valid for a grace period. See
  `oracle/src/aggregator/key-rotation.ts`.
- **Data adapter** — A module that fetches real-world outcome data for a
  market category from an external source (CoinGecko, Binance, TheOddsAPI,
  Reuters, Polymarket feed, etc.), used by the oracle to propose outcomes.
  See `oracle/src/adapters/`.
- **Confidence** — A data adapter's self-reported certainty (0–1) in the
  outcome it fetched; only results at or above a threshold are used to submit
  an outcome.

## Backend & data

- **Indexer** — The service that polls Soroban `getEvents()`, decodes
  contract events, and writes them into PostgreSQL so the backend can serve
  fast reads instead of hitting Soroban RPC directly. See
  [`INDEXER_RUNBOOK.md`](INDEXER_RUNBOOK.md).
- **Checkpoint** — The last ledger sequence the indexer has fully processed;
  persisted so polling can resume after a restart without reprocessing or
  skipping events.
- **Backend / API** — The Fastify REST API (`backend/`) that serves markets,
  bets, leaderboard, and stats data from the indexed database, with a Redis
  cache in front. See `backend/README.md`.
- **Leaderboard** — The denormalized ranking snapshot (points, won/lost bets
  per address) served to the frontend, rebuilt from the raw event log by the
  leaderboard-rebuild job when needed.
- **Leaderboard rebuild** — The job that replays claim and referral events
  and re-derives the `leaderboard` table from scratch, keyed by wallet
  address. See ["Leaderboard Rebuild Job" in `ORACLE_AND_BACKEND.md`](ORACLE_AND_BACKEND.md#leaderboard-rebuild-job).
- **Events table** — The raw on-chain event audit log (`events`) that the
  indexer writes to and that backfill/rebuild jobs replay from. See
  [`DB_SCHEMA.md`](DB_SCHEMA.md#events).
- **Migration** — A numbered SQL file under `db/migrations/` that creates or
  alters the shared schema, applied in filename order. See
  [`DB_SCHEMA.md`](DB_SCHEMA.md#migrations).
- **Cache-aside** — The caching pattern used by the backend: read from Redis
  first, fall back to Postgres on a miss, then populate the cache — see
  `backend/src/cache/cacheAside.ts`.
- **Rate limiter** — The per-IP request-limiting layer backed by Redis, with
  limits declared per route (see `backend/src/config/rateLimits.ts`).

## Infrastructure

- **RPC (Soroban RPC)** — The JSON-RPC endpoint (`SOROBAN_RPC_URL`) the
  indexer, oracle, and (as a fallback) the frontend use to read on-chain
  state and events. See ["RPC trust" in `SECURITY_BACKEND.md`](SECURITY_BACKEND.md#rpc-trust).
- **Resolver key / RESOLVER_KEY** — The secret Stellar key the
  `oracle-aggregator` service holds to sign and submit `resolve_market`
  transactions on the council's behalf. See
  [`SECURITY_BACKEND.md`](SECURITY_BACKEND.md#key-inventory).
- **Council members** — The `COUNCIL_MEMBERS` list of public keys authorized
  to submit council votes; configured per deployment, not on-chain.
