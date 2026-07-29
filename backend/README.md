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

## Endpoints (target)

See [`docs/ORACLE_AND_BACKEND.md`](../docs/ORACLE_AND_BACKEND.md#api-endpoints).
Each endpoint is tracked as its own issue.

Feature routes are served under `/api/v1`, mounted from the route index in
[`src/api/index.ts`](src/api/index.ts) — route files declare paths relative to
the version (`/profile/:address`), never the full `/api/v1/...`. A breaking
change means mounting a `v2` beside `v1`, not rewriting every route file.
Operational endpoints (`/healthz`, `/api/docs`) stay unversioned: they are
infrastructure, not part of the contract clients code against.

Live already:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe |
| `GET /api/docs` | OpenAPI 3.1 spec, generated from the route schemas |
| `GET /api/v1/profile/:address` | A user's bets and leaderboard totals |

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
