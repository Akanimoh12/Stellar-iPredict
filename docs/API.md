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

- Operational endpoints (`/healthz`, `/readyz`, `/status`, `/api/docs`) are **unversioned**.
- Feature routes are served under **`/api/v1`** (mounted in
  `backend/src/api/index.ts` as `API_PREFIX = /api/v1`). Route files declare
  paths relative to the version, so `profile/:address` resolves to
  `/api/v1/profile/:address`.
- The markets routes (`/api/markets*`), leaderboard, and stats are currently
  registered at their **unversioned** paths as shown below.

#### Versioning and compatibility policy

- The version in the URL is the API's major version. New versioned feature
  routes use `/api/vN`; the OpenAPI `info.version` value describes the
  specification and is not a substitute for the URL version.
- Backward-compatible additions, such as new endpoints and optional request or
  response fields, stay in the current version. Clients should ignore unknown
  response fields.
- Removing or renaming an endpoint or field, changing a field's type or
  meaning, making an optional input required, or otherwise changing existing
  behavior incompatibly requires a new major version. A new version is mounted
  alongside the old one; existing versioned paths are not silently redirected
  to or changed into the new version.
- The unversioned feature routes listed in this reference remain at their
  current paths. They are not implicitly part of `/api/v1`; any replacement or
  retirement of those routes will be announced under the same deprecation
  policy.

#### Deprecation policy

- A version or endpoint will be deprecated only after its replacement is
  available. The deprecation notice will identify the affected routes, the
  replacement, migration guidance, and the planned retirement date in this
  reference and the generated OpenAPI document.
- Deprecated responses will include the standard `Deprecation` and `Sunset`
  headers, and a `Link` header pointing to the successor when one is available.
- At least **six months' notice** will be given between the replacement becoming
  available and the planned retirement. A security, legal, or data-integrity
  issue may require a shorter period; in that case, notice and migration
  guidance will be provided as early as practical.
- No API version or endpoint is currently announced as deprecated, and no
  retirement date has been set.

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

- `GET /api/docs` — OpenAPI specification for this API
- `GET /api/leaderboard` — Leaderboard rankings
- `GET /api/markets` — List markets with filtering, sorting and pagination
- `GET /api/markets/resolution-status` — Whether market resolution is currently delayed
- `GET /api/markets/unmappable` — Open markets that may be unresolvable, soonest to expire first
- `GET /api/markets/{id}` — Get details of a market from its ID
- `GET /api/markets/{id}/bets` — List bets for a market, paginated
- `GET /api/markets/{id}/odds` — Get derived odds and implied probabilities for a market
- `POST /api/oracle/submit` — [DEPRECATED] Use /api/v1/oracle/submit instead
- `GET /api/stats` — Platform-wide aggregate stats
- `POST /api/v1/oracle/submit` — Provider submission intake
- `GET /api/v1/profile/{address}` — Get a user's profile: their bets and leaderboard stats
- `GET /api/v1/profile/{address}/bets` — Get a user's paginated bet history
- `GET /healthz` — Liveness probe
- `GET /resolution-status` — Oracle resolution health — detects aggregator unavailability from overdue markets
- `GET /status` — Public status feed for a status page

---

### GET /api/docs

OpenAPI specification for this API

**Tags:** system

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |

---

### GET /api/leaderboard

Returns a paginated leaderboard of top players by points or bet count. This is aggregate, non-user-specific data safe for shared caches.

**Tags:** leaderboard

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `offset` | query | integer | no | Pagination offset (maximum 10000; use cursor-based pagination for deeper results) |
| `limit` | query | integer | no | Page size (maximum 100) |
| `sort` | query | string | no | Sort field. One of `points`, `bets`. |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 304 | Not modified — ETag matched | none |
| 400 | Default Response | object |

---

### GET /api/markets

List markets with filtering, sorting and pagination

**Tags:** markets

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `filter` | query | string | no | Filter markets by status. One of `active`, `resolved`, `ended`, `cancelled`, `all`. |
| `category` | query | string | no | Filter by market category. Accepts: Crypto, Sports, Politics, Entertainment, Science. Case-insensitive and whitespace-trimming. |
| `sort` | query | string | no | Sort order. One of `newest`, `volume`, `ending_soon`, `bettors`. |
| `page` | query | integer | no | Page number (1-indexed). (page - 1) × limit must not exceed 10000; use cursor-based pagination for deeper results. |
| `limit` | query | integer | no | Results per page (maximum 100) |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 304 | Not Modified | none |
| 400 | Default Response | object |

---

### GET /api/markets/resolution-status

Whether market resolution is currently delayed

**Tags:** markets

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |

---

### GET /api/markets/unmappable

Candidate set for the oracle's mappability sweep (#745). The backend does not know which markets an adapter can query, so it returns open, un-cancelled markets ordered by end_time ascending. Markets already past end_time lead the list: they are the ones holding stakes with no resolution path.

**Tags:** markets

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |

---

### GET /api/markets/{id}

Get details of a market from its ID

**Tags:** markets

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `id` | path | string | yes | Positive integer market id |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |
| 404 | Default Response | object |

---

### GET /api/markets/{id}/bets

List bets for a market, paginated

**Tags:** markets

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `page` | query | integer | no | Page number (1-indexed). (page - 1) × limit must not exceed 10000; use cursor-based pagination for deeper results. |
| `limit` | query | integer | no | Results per page (maximum 100) |
| `id` | path | string | yes | Positive integer market id |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |
| 404 | Default Response | object |

---

### GET /api/markets/{id}/odds

Get derived odds and implied probabilities for a market

**Tags:** markets

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `id` | path | string | yes | Positive integer market id |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |
| 404 | Default Response | object |

---

### POST /api/oracle/submit

Legacy endpoint. Migrating to versioned API.

**Tags:** oracle

**Authentication:** bearer token (oracleApiKey).

**Parameters:** none.

**Request body:** object (required).

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |
| 401 | Default Response | object |
| 409 | Default Response | object |

---

### GET /api/stats

Platform-wide aggregate stats

**Tags:** stats

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 304 | Not modified — ETag matched | none |

---

### POST /api/v1/oracle/submit

Submit an oracle outcome for a market guarded by API-key auth with replay protection

**Tags:** oracle

**Authentication:** bearer token (oracleApiKey).

**Parameters:** none.

**Request body:** object (required).

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |
| 401 | Default Response | object |
| 403 | Default Response | object |
| 404 | Default Response | object |
| 409 | Default Response | object |

---

### GET /api/v1/profile/{address}

Returns public leaderboard aggregates (points, wins, losses) and the bet history for the given Stellar address. **This is user-specific data — the response is marked no-store and must never be cached by a shared proxy or CDN.**

**Tags:** markets

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `address` | path | string | yes | A Stellar public key (G…, 56 Base32 characters). |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |

---

### GET /api/v1/profile/{address}/bets

Returns the bets placed by a Stellar address, newest first. This user-specific response is never cached.

**Tags:** markets

**Authentication:** none.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `page` | query | integer | no | — |
| `limit` | query | integer | no | — |
| `address` | path | string | yes | A Stellar public key. |

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 400 | Default Response | object |

---

### GET /healthz

Liveness probe

**Tags:** system

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |

---

### GET /resolution-status

Oracle resolution health — detects aggregator unavailability from overdue markets

**Tags:** system

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |
| 503 | Default Response | object |

---

### GET /status

Health of the API, indexer progress, and the last resolved market. Always returns 200 — read the `status` field, not the HTTP code.

**Tags:** system

**Authentication:** none.

**Parameters:** none.

**Responses:**

| Status | Description | Body |
|--------|-------------|------|
| 200 | Default Response | object |

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
