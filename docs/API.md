# iPredict Backend API Reference

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

> This reference is generated from the backend source on `implementation-drips`
> (mostly `backend/src/api/*` and `backend/src/server.ts`). It is machine-checked
> against the route registrations in `backend/src`. A live, always-current
> OpenAPI 3.1 document is served by the API itself at `GET /api/docs`.

## Overview

The API is a **Fastify** service (`backend/src/server.ts`) that serves market,
bet, leaderboard, and stats data to the frontend. It reads from an indexed
PostgreSQL copy of on-chain state (written by the
[`indexer/`](../indexer)) with an optional Redis cache-aside layer in front.

### Base URL

- Default local port: **`4000`** (`PORT` env, see
  [`backend/.env.example`](../backend/.env.example)).
- Listen host: `0.0.0.0` (`HOST` env).
- Example: `http://localhost:4000/api/markets`

### Versioning

- Operational endpoints (`/healthz`, `/readyz`, `/api/docs`) are **unversioned**.
- Feature routes are served under **`/api/v1`** (mounted in
  `backend/src/api/index.ts` as `API_PREFIX = /api/v1`). Route files declare
  paths relative to the version, so `profile/:address` resolves to
  `/api/v1/profile/:address`.
- The markets routes (`/api/markets*`), leaderboard, and stats are currently
  registered at their **unversioned** paths as shown below.

### Authentication

There is **no authentication** on the read endpoints documented here. The
OpenAPI document defines an `oracleApiKey` bearer security scheme intended for
the not-yet-registered oracle submission endpoints (`POST /api/oracle/*`), but
no such route is currently registered, so no endpoint requires a token today.

### General conventions

- **Errors** use a single envelope for the framework-handled routes:
  `{ "error": { "code": "...", "message": "..." } }`. (Some routes return a
  flatter shape — noted per endpoint below.)
- **Unknown paths** → `404` `NOT_FOUND`; a known path called with the wrong
  method → `405` `METHOD_NOT_ALLOWED` with an `Allow` header.
- **Rate limiting** is enforced per route (see
  [Rate limiting](#rate-limiting)). When exceeded, a `429` is returned with a
  `Retry-After` header.
- **CORS:** responses carry CORS headers only for origins in the allowlist
  (`CORS_ORIGINS`); requests with no `Origin` header are unaffected.
- **Request ID:** every request is logged with a correlation id, echoed back in
  the `x-request-id` response header (configurable via
  `REQUEST_ID_HEADER`). A valid inbound `x-request-id` is reused.
- **Numeric amounts** (`total_yes`, `total_no`) are returned as **strings**
  because PostgreSQL `NUMERIC` values are serialised as strings.

## Endpoints

- `GET /healthz` — liveness probe
- `GET /readyz` — readiness probe (DB + Redis)
- `GET /api/docs` — OpenAPI 3.1 specification (JSON)
- `GET /api/markets` — list markets (filter/sort/paginate)
- `GET /api/markets/:id` — market detail
- `GET /api/leaderboard` — player rankings
- `GET /api/stats` — global platform statistics
- `GET /api/v1/profile/:address` — a user's bets + leaderboard totals

---

### GET /healthz

**Description:** Liveness probe. Returns a fixed `200` with a static body
unless the process itself is down.

**Authentication:** none.

**Query Parameters:** none.

**Response** `200 OK`:
```json
{ "status": "ok" }
```

---

### GET /readyz

**Description:** Readiness probe. Verifies that PostgreSQL and Redis are
reachable. Returns `200` when both are healthy and `503` otherwise.

**Authentication:** none.

**Query Parameters:** none.

**Response** `200 OK`:
```json
{
  "status": "ready",
  "checks": {
    "db":   { "ok": true,  "latencyMs": 2 },
    "redis":{ "ok": true,  "latencyMs": 3 }
  }
}
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 503 | Either `db.ok` or `redis.ok` is `false`. Body: `{ "status": "not ready", "checks": { "db": { "ok": false, "error": "..." }, "redis": { ... } } }` |

---

### GET /api/docs

**Description:** Returns the generated OpenAPI 3.1 specification as JSON.
Generated from the `schema` attached to each route, so it cannot drift from the
implementation.

**Authentication:** none.

**Query Parameters:** none.

**Response** `200 OK`:
```json
{
  "openapi": "3.1.0",
  "info": { "title": "iPredict API", "version": "0.1.0" },
  "paths": { ... }
}
```

---

### GET /api/markets

**Description:** List markets with filtering, sorting, and pagination. This is
the hot read path the frontend market list and the synthetic probes use.

**Authentication:** none.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `filter` | `string` | no | `all` | One of `active`, `resolved`, `ended`, `cancelled`, `all`. |
| `category` | `string` | no | — | One of `Crypto`, `Sports`, `Politics`, `Entertainment`, `Science`. |
| `sort` | `string` | no | `newest` | One of `newest`, `volume`, `ending_soon`, `bettors`. |
| `page` | `integer` | no | `1` | 1-indexed page number (min 1). |
| `limit` | `integer` | no | `20` | Results per page (1–100). |

**Filter semantics** (from `backend/src/db/markets.ts`):

| filter | SQL condition |
|--------|---------------|
| `active` | `resolved = false AND cancelled = false AND end_time > now()` |
| `resolved` | `resolved = true` |
| `ended` | `resolved = false AND cancelled = false AND end_time <= now()` |
| `cancelled` | `cancelled = true` |
| `all` | *(no filter)* |

**Sort semantics:** `newest` → `created_at DESC`; `volume` →
`(total_yes + total_no) DESC`; `ending_soon` → `end_time ASC`; `bettors` →
`bet_count DESC`.

**Response** `200 OK`:
```json
{
  "markets": [
    {
      "id": 1,
      "question": "Will Stellar XLM reach $1 in 2026?",
      "image_url": "https://example.com/image.png",
      "category": "Crypto",
      "end_time": "1735689600",
      "total_yes": "100.0000000",
      "total_no": "50.0000000",
      "resolved": false,
      "outcome": null,
      "cancelled": false,
      "creator": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "bet_count": 5,
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

`total` is the count of rows across all pages; `page` and `limit` echo the
requested (or default) values.

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid `filter`/`category`/`sort`, or `page`/`limit` out of range (e.g. `limit > 100`, `page = 0`). Body: `{ "error": { "code": "BAD_REQUEST", "message": "Invalid query parameters", "issues": [...] } }` |
| 429 | Rate limit exceeded (60 req/min window per IP for this route). |

---

### GET /api/markets/:id

**Description:** Returns a single market by its integer id, or `404` if it does
not exist.

**Authentication:** none.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Positive integer market id. |

**Query Parameters:** none.

**Response** `200 OK`:
```json
{
  "id": 42,
  "question": "Will the price of ETH exceed $4,000?",
  "image_url": null,
  "category": "Crypto",
  "end_time": "1735689600",
  "total_yes": "60.0000000",
  "total_no": "40.0000000",
  "resolved": false,
  "outcome": null,
  "cancelled": false,
  "creator": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "bet_count": 3,
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 400 | `id` is not a positive integer (e.g. `GET /api/markets/not-a-number`). |
| 404 | Market not found. Body: `{ "error": { "code": "NOT_FOUND", "message": "Market not found" } }` |
| 429 | Rate limit exceeded (120 req/min window for this route). |

---

### GET /api/leaderboard

**Description:** Returns paginated, sortable player rankings from the
`leaderboard` snapshot table.

**Authentication:** none.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `offset` | `integer` | no | `0` | 0-based offset (min 0). |
| `limit` | `integer` | no | `20` | Results per page (1–100). |
| `sort` | `string` | no | `points` | One of `points`, `bets`. |

**Sort semantics:** `points` → `points DESC`; `bets` →
`(won_bets + lost_bets) DESC`.

**Response** `200 OK`:
```json
{
  "players": [
    {
      "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "display_name": "best_bettor",
      "points": "83",
      "won_bets": 30,
      "lost_bets": 2,
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "total": 1
}
```

Note: `points` is returned as a string (`BIGINT`), while `won_bets` /
`lost_bets` are numbers. `total` is the total number of leaderboard rows.

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid query parameters. Body (flat shape): `{ "code": "BAD_REQUEST", "message": "Invalid leaderboard query parameters", "issues": [...] }` |
| 429 | Rate limit exceeded (this route falls under the default 30 req/min). |

---

### GET /api/stats

**Description:** Returns global platform statistics computed from the database.

**Authentication:** none.

**Query Parameters:** none.

**Response** `200 OK`:
```json
{
  "totalMarkets": 7,
  "totalVolume": "12345.6780000",
  "totalUsers": 31,
  "totalBets": 120
}
```

`totalVolume` is a string (sum of `total_yes + total_no` across markets).

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 429 | Rate limit exceeded (default 30 req/min). |

---

### GET /api/v1/profile/:address

**Description:** Returns a user's bet history and leaderboard aggregates
(points, wins, losses). Unregistered addresses return empty bet history and
zeroed aggregates rather than an error.

**Authentication:** none.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `address` | `string` | Stellar public key: starts with `G`, 56 characters, Base32. Matched by `^G[A-Z2-7]{55}$`. |

**Query Parameters:** none.

**Response** `200 OK`:
```json
{
  "bets": [
    {
      "market_id": "1",
      "bettor": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "net_amount": "10.0000000",
      "gross_amount": "10.2040816",
      "is_yes": true,
      "claimed": false,
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "points": "83",
  "won_bets": 30,
  "lost_bets": 2
}
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 400 | `address` does not match the Stellar address format. Body (flat shape): `{ "error": "Bad Request", "message": "Invalid Stellar address format" }` |
| 500 | Failed to fetch profile data. Body (flat shape): `{ "error": "Internal Server Error", "message": "Failed to fetch user profile data" }` |
| 429 | Rate limit exceeded (default 30 req/min). |

---

## Health Check

Two health endpoints are exposed:

- `GET /healthz` — liveness: returns `{ "status": "ok" }` with `200`.
- `GET /readyz` — readiness: verifies DB and Redis, returning `200`/`ready` or
  `503`/`not ready` with per-check `ok`/`latencyMs`/`error`.

Point uptime probes at `GET /healthz` (cheap liveness) and `GET /readyz`
(dependency readiness). See
[`infra/monitoring/synthetic.md`](../infra/monitoring/synthetic.md) for the
synthetic monitoring configuration.

## Rate Limiting

Rate limiting is enforced with an in-memory sliding window
(`backend/src/cache/rateLimiter.ts`), configured in
`backend/src/config/rateLimits.ts`. When the budget is exceeded the client
receives `429` with a `Retry-After` header, plus `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and `X-RateLimit-Reset` informational headers on every
request.

| Method / path | requests | window |
|---------------|----------|--------|
| `GET /api/markets` | 60 | 60s |
| `GET /api/markets/:id` | 120 | 60s |
| `POST /api/oracle/*` | 10 | 60s |
| default (everything else) | 30 | 60s |

## Caching

Read-heavy endpoints use a Redis cache-aside layer (`backend/src/cache/`):

| Endpoint | Cache key (example) | TTL |
|----------|---------------------|-----|
| `GET /api/markets` (all) | `ipredict:v1:markets:list:all:all:newest:1:20` | 30s |
| `GET /api/markets` (active) | `ipredict:v1:markets:list:active:all:newest:1:20` | 15s |
| `GET /api/markets/:id` | `ipredict:v1:market:42` | 30s |
| `GET /api/leaderboard` | `ipredict:v1:leaderboard:points:20:0` | 60s |
| `GET /api/stats` | `ipredict:v1:stats:global` | 60s |

The keys use the `ipredict:v1` namespace; see
`backend/src/cache/cacheKeys.ts`. The indexer invalidates these keys when it
writes new events, so the API never serves stale-on-chain data for long.

## Environment Variables

Read by the backend (`backend/src/config/index.ts` and `.env.example`):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string (shared with the indexer). |
| `PORT` | no | `4000` | HTTP listen port. |
| `HOST` | no | `0.0.0.0` | HTTP listen host. |
| `CORS_ORIGINS` | no | `http://localhost:3000` | Comma-separated allowed browser origins. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis cache URL. When unreachable, routes read the DB directly. |
| `DB_POOL_SIZE` | no | `10` | Postgres pool max connections. |
| `DB_IDLE_TIMEOUT_MS` | no | `30000` | Postgres pool idle timeout. |
| `DB_CONNECTION_TIMEOUT_MS` | no | `5000` | Postgres pool connection timeout. |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production`. |
| `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`, `MARKET_CONTRACT_ID`, `TOKEN_CONTRACT_ID`, `REFERRAL_CONTRACT_ID`, `LEADERBOARD_CONTRACT_ID` | — | — | Present in `.env.example`; required by the upstream indexer, currently unused by the backend API routes. |
