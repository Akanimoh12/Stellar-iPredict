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
