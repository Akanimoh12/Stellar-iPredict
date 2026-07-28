# iPredict Backend API

REST API that serves market, bet, leaderboard, and stats data to the frontend —
reading from an indexed PostgreSQL copy of on-chain state (written by the
[`indexer/`](../indexer)) with a Redis cache in front, instead of hitting Soroban
RPC directly on every request.

> **Branch:** all work happens on `implementation-drips`. Open PRs against that
> branch, **not** `main`.

## Why this exists

The frontend currently reads markets directly from Soroban RPC. That works for
<100 markets but throttles and slows badly past ~500. This service is the
scalable read path. See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md)
for the full design.

## Stack

- **Runtime:** Node.js 20+, TypeScript
- **HTTP:** Fastify
- **DB:** PostgreSQL 16 (shared with the indexer)
- **Cache:** Redis 7
- **Validation:** Zod
- **Stellar:** `@stellar/stellar-sdk`

## Layout

```
backend/
  src/
    api/         route handlers (markets, leaderboard, stats, oracle)
    db/          query layer (shared schema lives in ../db migrations)
    cache/       Redis client + cache helpers
    config/      env loading & validation
    lib/         shared utilities
    server.ts    Fastify bootstrap
    index.ts     entrypoint
  test/
  package.json
  tsconfig.json
  .env.example
```

## Getting started

```bash
cd backend
cp .env.example .env        # fill in DATABASE_URL, REDIS_URL, contract IDs
npm install
npm run dev                 # starts the API on :4000
```

You need Postgres and Redis running locally (see
[`infra/`](../infra) for a docker-compose that starts both).

## Endpoints

See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#api-endpoints) for the architecture specification.
Each endpoint is tracked as its own issue.

Feature routes are served under `/api/v1`, mounted from the route index in
[`src/api/index.ts`](src/api/index.ts) — route files declare paths relative to
the version (`/profile/:address`), never the full `/api/v1/...`. A breaking
change means mounting a `v2` beside `v1`, not rewriting every route file.
Operational endpoints (`/healthz`, `/readyz`, `/api/docs`) stay unversioned: they are
infrastructure, not part of the contract clients code against.

### Summary Table

#### Live Endpoints

| Endpoint | Method | Category | Description | Cache / TTL |
| --- | --- | --- | --- | --- |
| `/healthz` | `GET` | System | Liveness probe (returns `{ "status": "ok" }`) | No cache |
| `/readyz` | `GET` | System | Readiness probe verifying DB (`pingDb`) & Redis (`pingRedis`) connectivity | No cache |
| `/api/docs` | `GET` | System | OpenAPI 3.1 specification JSON generated via `@fastify/swagger` | Dynamic |
| `/api/v1/profile/:address` | `GET` | Feature | User's bet history and leaderboard totals (`points`, `won_bets`, `lost_bets`) | DB query |
| `/api/markets` | `GET` | Feature | List markets with status filter, category filter, sorting, and pagination | Redis cache (15s active / 30s default) |
| `/api/markets/:id` | `GET` | Feature | Market details by positive integer ID | Redis cache (30s) |
| `/api/leaderboard` | `GET` | Feature | Ranked player leaderboard sorted by points or bets with pagination | Redis cache (60s) |
| `/api/stats` | `GET` | Feature | Global platform aggregate statistics (`totalMarkets`, `totalVolume`, `totalUsers`, `totalBets`) | Redis cache (60s) |

#### Target / Planned Endpoints (Phase 2 & Oracle Workflows)

| Endpoint | Method | Category | Description | Auth / Security |
| --- | --- | --- | --- | --- |
| `/api/markets/:id/bets` | `GET` | Feature | Paginated list of bets placed on a specific market | Public |
| `/api/oracle/submit` | `GET` / `POST` | Oracle | Outcome submission by authorized oracle providers | Bearer Token (`oracleApiKey`) |

---

### Endpoint Reference & Specifications

#### 1. Liveness Probe
- **Route**: `GET /healthz`
- **Description**: Lightweight health check for container orchestrators (Kubernetes / Docker).
- **Time Complexity**: $O(1)$
- **Response `200 OK`**:
  ```json
  { "status": "ok" }
  ```

#### 2. Readiness Probe
- **Route**: `GET /readyz`
- **Description**: Verifies active connectivity and latency for PostgreSQL database pool and Redis cache.
- **Time Complexity**: $O(1)$ ping operations.
- **Response `200 OK`** (Ready):
  ```json
  {
    "status": "ready",
    "checks": {
      "db": { "ok": true, "latencyMs": 2.4 },
      "redis": { "ok": true, "latencyMs": 1.1 }
    }
  }
  ```
- **Response `503 Service Unavailable`** (Not Ready):
  ```json
  {
    "status": "not ready",
    "checks": {
      "db": { "ok": false, "error": "Connection refused" },
      "redis": { "ok": true, "latencyMs": 1.0 }
    }
  }
  ```

#### 3. OpenAPI Documentation Spec
- **Route**: `GET /api/docs`
- **Description**: Serves the auto-generated OpenAPI 3.1.0 specification document for all registered schemas.
- **Time Complexity**: $O(1)$ schema serialization.
- **Response `200 OK`**: JSON OpenAPI 3.1.0 specification object.

#### 4. User Profile
- **Route**: `GET /api/v1/profile/:address`
- **Description**: Retrieves a user's bet history and leaderboard aggregates by Stellar public key address.
- **Parameters**:
  - `address` (path, string): Valid 56-character Stellar public key matching `/^G[A-Z2-7]{55}$/`.
- **Time Complexity**: $O(K + \log N)$ where $K$ is user's bet count and $N$ is leaderboard rows (indexed B-tree lookup).
- **Response `200 OK`**:
  ```json
  {
    "bets": [
      {
        "market_id": "1",
        "bettor": "GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD",
        "net_amount": "98.0000000",
        "gross_amount": "100.0000000",
        "is_yes": true,
        "claimed": false,
        "created_at": "2026-07-27T10:00:00.000Z"
      }
    ],
    "points": "83",
    "won_bets": 2,
    "lost_bets": 0
  }
  ```
- **Response `400 Bad Request`**:
  ```json
  {
    "error": "Bad Request",
    "message": "Invalid Stellar address format"
  }
  ```

#### 5. List Markets
- **Route**: `GET /api/markets`
- **Description**: Fetch prediction markets with query filtering, sorting, and pagination. Served via cache-aside Redis.
- **Query Parameters**:
  - `filter` (enum: `active` | `resolved` | `ended` | `cancelled` | `all`, default: `all`)
  - `category` (enum: `Crypto` | `Sports` | `Politics` | `Entertainment` | `Science`, optional)
  - `sort` (enum: `newest` | `volume` | `ending_soon` | `bettors`, default: `newest`)
  - `page` (integer $\ge 1$, default: `1`)
  - `limit` (integer $1..100$, default: `20`)
- **Time Complexity**: $O(1)$ on Redis cache hit; $O(M \log M)$ DB index scan on cache miss bounded by `limit`.
- **Response `200 OK`**:
  ```json
  {
    "markets": [
      {
        "id": 1,
        "question": "Will XLM exceed $0.50 by end of Q2 2026?",
        "image_url": "https://ipredict.app/images/xlm.png",
        "category": "Crypto",
        "end_time": "1775000000",
        "total_yes": "500.0000000",
        "total_no": "300.0000000",
        "resolved": false,
        "outcome": null,
        "cancelled": false,
        "creator": "GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD",
        "bet_count": 12,
        "created_at": "2026-02-01T00:00:00.000Z",
        "updated_at": "2026-02-01T00:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
  ```

#### 6. Market Detail
- **Route**: `GET /api/markets/:id`
- **Description**: Retrieves single market record by positive integer ID.
- **Parameters**:
  - `id` (path, string): Positive integer market ID.
- **Time Complexity**: $O(1)$ Redis cache hit / DB primary key lookup.
- **Response `200 OK`**: Market object.
- **Response `404 Not Found`**:
  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Market not found"
    }
  }
  ```

#### 7. Leaderboard Rankings
- **Route**: `GET /api/leaderboard`
- **Description**: Paginated list of top players ranked by points or bet count.
- **Query Parameters**:
  - `offset` (integer $\ge 0$, default: `0`)
  - `limit` (integer $1..100$, default: `20`)
  - `sort` (enum: `points` | `bets`, default: `points`)
- **Time Complexity**: $O(1)$ on Redis cache hit; $O(\log N + K)$ indexed scan.
- **Response `200 OK`**:
  ```json
  {
    "players": [
      {
        "address": "GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD",
        "display_name": "CryptoKing",
        "points": "83",
        "won_bets": 5,
        "lost_bets": 1
      }
    ],
    "total": 31
  }
  ```

#### 8. Global Platform Statistics
- **Route**: `GET /api/stats`
- **Description**: Aggregate platform metrics including total markets, volume, distinct users, and bets.
- **Time Complexity**: $O(1)$ on Redis cache hit; aggregate DB query (60s TTL).
- **Response `200 OK`**:
  ```json
  {
    "totalMarkets": 15,
    "totalVolume": "12500.5000000",
    "totalUsers": 31,
    "totalBets": 142
  }
  ```

#### 9. Market Bets (Target / Planned)
- **Route**: `GET /api/markets/:id/bets`
- **Description**: Paginated list of bets placed on a specific market.
- **Query Parameters**: `page`, `limit`.

#### 10. Oracle Resolution Submission (Target / Planned)
- **Route**: `POST /api/oracle/submit`
- **Description**: Post outcome submissions signed by authorized oracle providers.
- **Authentication**: Bearer API key (`oracleApiKey`).
- **Body**: `{ "marketId": 1, "outcome": true, "signature": "...", "provider": "..." }`

## API hardening

- **CORS** — allowlist only, from `CORS_ORIGINS` (comma-separated). Unset falls
  back to `http://localhost:3000`; an empty value allows no browser origin.
  Requests without an `Origin` header (curl, health checks, service-to-service)
  are unaffected. A disallowed origin gets a normal response with no CORS
  headers, which is what makes the browser block the read.
- **Security headers** — `@fastify/helmet` with a locked-down CSP (`default-src
  'none'`), `frame-ancestors 'none'`, HSTS and `Referrer-Policy: no-referrer`.
- **Request logging** — one structured line per request carrying a correlation
  id, echoed back in the `x-request-id` response header. A valid inbound
  `x-request-id` is reused so a trace survives the frontend → API hop.
- **OpenAPI** — adding a `schema` to a route documents it automatically; there
  is no separate spec file to keep in sync.
- **Errors** — every failure, including unknown routes, is one envelope:
  `{ "error": { "code": "...", "message": "..." } }`. An unknown path is a `404`
  (`NOT_FOUND`); a known path called with the wrong method is a `405`
  (`METHOD_NOT_ALLOWED`) carrying an `Allow` header, rather than Fastify's
  default 404 that reads as "this resource does not exist" when it does.

## Contributing

1. Pick an open issue labelled `area:backend` (or `area:api`).
2. Comment to claim it.
3. Branch off `implementation-drips`, implement, open a PR back to
   `implementation-drips`.
