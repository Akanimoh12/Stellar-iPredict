# Environment Variables Reference

Comprehensive single source of truth for all environment variables used across the iPredict production stack (`backend`, `indexer`, `oracle`, `db`, and `frontend`).

All Node services utilize [`loadSecrets()`](../shared/src/secrets.ts) before configuration schemas are evaluated, allowing any sensitive credential to be provided either via ambient environment or via `<NAME>_FILE` mounted paths (e.g. Docker Secrets, Kubernetes Secrets, or HashiCorp Vault Agent).

---

## Table of Contents

1. [Common & Infrastructure](#1-common--infrastructure)
2. [Smart Contract Addresses](#2-smart-contract-addresses)
3. [Backend API (`backend`)](#3-backend-api-backend)
4. [Event Indexer (`indexer`)](#4-event-indexer-indexer)
5. [Oracle Aggregator & Monitor (`oracle`)](#5-oracle-aggregator--monitor-oracle)
6. [Frontend Web Application (`frontend`)](#6-frontend-web-application-frontend)
7. [Secrets & File Indirection `<NAME>_FILE`](#7-secrets--file-indirection-name_file)

---

## 1. Common & Infrastructure

| Variable | Services | Required (Prod) | Default / Allowed | Description |
|---|---|---|---|---|
| `DATABASE_URL` | `backend`, `indexer`, `oracle`, `db` | **Yes** | — | PostgreSQL connection string (`postgres://user:pass@host:5432/dbname`). |
| `REDIS_URL` | `backend`, `indexer` | Optional | `redis://localhost:6379` | Redis connection URL for caching, cache invalidation, and rate limiting. |
| `SOROBAN_RPC_URL` | `backend`, `indexer`, `oracle` | **Yes** | — | HTTPS endpoint for Stellar Soroban RPC node (e.g., `https://mainnet.sorobanrpc.com`). |
| `NETWORK_PASSPHRASE` | `backend`, `indexer`, `oracle` | **Yes** | `Test SDF Network ; September 2015` | Stellar network passphrase (`Public Global Stellar Network ; September 2015` for Mainnet). |
| `NODE_ENV` | All | Optional | `development` | Runtime environment: `production`, `development`, or `test`. |
| `LOG_LEVEL` | All | Optional | `info` | Logging verbosity: `debug`, `info`, `warn`, `error`. |
| `SECRETS_BACKEND` | `backend`, `indexer`, `oracle` | Optional | `env` | Source of secrets: `env` (ambient), `env-file` (reads `SECRETS_ENV_FILE`), or `vault`. |
| `SECRETS_ENV_FILE` | `backend`, `indexer`, `oracle` | Optional | `.env` | File path when `SECRETS_BACKEND=env-file`. |

---

## 2. Smart Contract Addresses

Deployed Soroban contract addresses (C... format) from deployment manifests (`deploy-mainnet-output.json`):

| Variable | Services | Required (Prod) | Description |
|---|---|---|---|
| `MARKET_CONTRACT_ID` | `backend`, `indexer`, `oracle` | **Yes** | Core prediction market contract identifier. |
| `TOKEN_CONTRACT_ID` | `backend`, `indexer` | Optional | IPRED token contract identifier. |
| `REFERRAL_CONTRACT_ID` | `backend`, `indexer` | Optional | Referral registry contract identifier. |
| `LEADERBOARD_CONTRACT_ID` | `backend`, `indexer` | Optional | Leaderboard and points contract identifier. |

---

## 3. Backend API (`backend`)

### Networking & Server
| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `PORT` | Optional | `4000` | Port for the HTTP API server to listen on. |
| `HOST` | Optional | `0.0.0.0` | Host interface to bind HTTP server to. |
| `CORS_ORIGINS` | **Yes** | Localhost only | Comma-separated list of allowed browser origins (no wildcards allowed when credentials enabled). |
| `TRUSTED_PROXIES` | Optional | `127.0.0.1/32,::1/128` | Comma-separated CIDR ranges of reverse proxies allowed for `X-Forwarded-For` resolution. |
| `BODY_LIMIT_BYTES` | Optional | `16384` (16 KiB) | Global maximum request payload size in bytes (returns 413 if exceeded). |
| `REQUEST_TIMEOUT_MS` | Optional | `30000` (30s) | Server-side request processing timeout in milliseconds. |
| `CONNECTION_TIMEOUT_MS` | Optional | `10000` (10s) | Socket connection timeout in milliseconds. |

### Database Pool Tuning
| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `DB_POOL_SIZE` | Optional | `10` | Maximum number of concurrent connections in pg pool. |
| `DB_IDLE_TIMEOUT_MS` | Optional | `30000` (30s) | Time before an idle client connection is terminated. |
| `DB_CONNECTION_TIMEOUT_MS` | Optional | `5000` (5s) | Connection acquisition timeout from pg pool. |
| `DB_SLOW_QUERY_THRESHOLD_MS` | Optional | `200` (200ms) | Query duration threshold for logging slow query warnings. |
| `DB_STATEMENT_TIMEOUT_MS` | Optional | `30000` (30s) | PostgreSQL statement timeout for queries. |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`| Optional | `60000` (60s) | PostgreSQL idle-in-transaction timeout. |

### Authentication & Rate Limits
| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `ORACLE_API_KEYS` | **Yes** | — | Per-provider oracle authentication keys in format `<providerAddress>:sha256$<digest>,...`. |
| `API_KEYS` | Optional | `""` | Comma-separated list of API keys qualifying for authenticated rate-limit tier. |

### Oracle & Submission Parameters
| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `SUBMITTER_BOND_XLM` | Optional | `100` | Minimum submitter bond required for oracle submissions in XLM. |
| `ORACLE_THRESHOLD` | Optional | `3` | Number of provider submissions required to achieve quorum. |
| `ORACLE_TIMESTAMP_WINDOW_SEC` | Optional | `300` (5 min) | Maximum allowed skew between signature timestamp and server time. |
| `ORACLE_NONCE_RETENTION_SEC` | Optional | `600` (10 min) | Retention duration for used nonces to prevent replay attacks. |
| `ORACLE_IDEMPOTENCY_RETENTION_SEC`| Optional | `86400` (24h) | Cache retention period for submission idempotency keys. |
| `ORACLE_AUTH_FAILURE_WINDOW_SEC` | Optional | `300` (5 min) | Rolling window the authentication-failure spike baseline is measured over (#576). |
| `ORACLE_AUTH_FAILURE_MIN_COUNT` | Optional | `10` | Authentication failures within the window before a spike is considered. |
| `ORACLE_AUTH_FAILURE_DISTINCT_SOURCES` | Optional | `5` | Distinct client origins at or above which a spike is classified as distributed guessing rather than a misconfigured provider. |
| `ORACLE_AUTH_FAILURE_COOLDOWN_SEC` | Optional | `300` (5 min) | Minimum time between two spike alerts of the same pattern. |

---

## 4. Event Indexer (`indexer`)

| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `START_LEDGER` | Optional | `0` | Ledger sequence to start indexing from if no checkpoint exists in database. |
| `POLL_INTERVAL_MS` | Optional | `5000` (5s) | Interval between Soroban event polling queries. |
| `EVENTS_PER_PAGE` | Optional | `200` | Maximum event batch size per RPC query page. |
| `METRICS_PORT` | Optional | `9091` | Port exposing Prometheus metrics (`GET /metrics`). |
| `METRICS_HOST` | Optional | `0.0.0.0` | Bind host for metrics endpoint. |

---

## 5. Oracle Aggregator & Monitor (`oracle`)

### Council & Aggregation
| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `COUNCIL_SIZE` | Optional | `7` | Total count of authorized council members. |
| `COUNCIL_THRESHOLD` | Optional | `4` | Strict majority required for council resolution (must be `> COUNCIL_SIZE / 2`). |
| `MIN_REQUIRED_SUBMISSIONS` | Optional | `4` | Minimum member submissions before finalization can trigger. |
| `COUNCIL_MEMBERS` | **Yes** | — | Comma-separated list of 7 council public keys (`G...`). |
| `RESOLVER_KEY` | **Yes** | — | Stellar secret key (`S...`) used to sign and submit `resolve_market` transactions. Recommended via `RESOLVER_KEY_FILE`. |
| `POLL_INTERVAL_MS` | Optional | `5000` (5s) | Polling interval checking for expired unresolved markets. |
| `SHUTDOWN_GRACE_MS` | Optional | `20000` (20s) | Grace period to drain in-flight resolutions during SIGTERM before shutdown. |
| `HEALTH_PORT` | Optional | `9103` | Port for liveness and readiness probes (`/healthz`, `/readyz`). |
| `METRICS_PORT` | Optional | `9102` | Port for Prometheus metrics scraper. |

### Webhook Notifications
| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `FINALIZE_WEBHOOK_URL` | Optional | — | Webhook endpoint called upon market finalization. |
| `WEBHOOK_SIGNING_SECRET` | Optional | — | HMAC-SHA256 secret for signing webhook payloads with `X-Signature` and `X-Timestamp`. |
| `FINALIZE_WEBHOOK_MAX_ATTEMPTS` | Optional | `5` | Retry attempts with exponential backoff before storing in dead-letter table. |

### Data Adapter Quote Freshness
Per-adapter bounds for how old a provider's price may be before the oracle
downweights or rejects it. See
[`docs/ORACLE_ADAPTER_FRESHNESS.md`](./ORACLE_ADAPTER_FRESHNESS.md) for the
support matrix and which providers cannot be checked at all.

| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS` | Optional | `120000` | Binance quotes older than this are rejected outright. |
| `ORACLE_BINANCE_FRESHNESS_STALE_AFTER_MS` | Optional | `30000` | Binance quotes older than this are downweighted. |
| `ORACLE_BINANCE_FRESHNESS_STALE_CONFIDENCE` | Optional | `0.5` | Confidence ceiling for a stale Binance quote. Keep below the resolution floor (`0.7`). |
| `ORACLE_BINANCE_FRESHNESS_UNTIMESTAMPED_CONFIDENCE` | Optional | `0.5` | Confidence ceiling when Binance returns no `closeTime`. |
| `ORACLE_COINMARKETCAP_FRESHNESS_*` | Optional | as above | Same four bounds, prefix `ORACLE_COINMARKETCAP_`. |
| `ORACLE_COINGECKO_FRESHNESS_*` | Optional | as above | Same four bounds, prefix `ORACLE_COINGECKO_`. |

An unparseable value is a startup error, not a silent fallback to the default.

### Market Mappability Overrides
Lets an operator declare a market→provider mapping valid without a redeploy,
and lets a delisted symbol be marked unservable. See
[`docs/MARKET_MAPPABILITY.md`](./MARKET_MAPPABILITY.md).

| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `MARKET_MAPPABILITY_OVERRIDES` | Optional | — | JSON object with `symbols`, `categories` and/or `unsupported`. Re-read on every lookup. |
| `MARKET_MAPPABILITY_OVERRIDES_FILE` | Optional | — | Path to a JSON file with the same shape. Mount it and edit in place; no restart needed. |
| `MARKET_PARAMS_FILE` | Optional | — | JSON of market id → adapter params, for the unmappable sweep. The database does not store these. |
| `UNMAPPABLE_SWEEP_WINDOW_SECONDS` | Optional | `2592000` (30d) | How far ahead `GET /api/markets/unmappable` looks. |
| `UNMAPPABLE_SWEEP_LIMIT` | Optional | `100` | Maximum candidate rows returned by that endpoint. |

Malformed override JSON is an error naming the source, not a silent fallback.

---

## 6. Frontend Web Application (`frontend`)

Frontend values are exposed to the client-side bundle via the Next.js `NEXT_PUBLIC_` prefix:

| Variable | Required (Prod) | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | **Yes** | `http://localhost:4000` | Base URL of the backend REST API. |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | **Yes** | `https://mainnet.sorobanrpc.com` | Soroban RPC provider endpoint. |
| `NEXT_PUBLIC_STELLAR_NETWORK` | **Yes** | `PUBLIC` | Target network (`PUBLIC` or `TESTNET`). |
| `NEXT_PUBLIC_MARKET_CONTRACT_ID` | **Yes** | — | Deployed market contract ID. |
| `NEXT_PUBLIC_TOKEN_CONTRACT_ID` | Optional | — | Deployed token contract ID. |

---

## 7. Secrets & File Indirection `<NAME>_FILE`

Production deployments should never store raw secrets in shell history or container environment listings. Any sensitive variable can be supplied via a file by appending `_FILE`:

```bash
# Example Docker / Kubernetes Secrets configuration
DATABASE_URL_FILE=/run/secrets/database_url
RESOLVER_KEY_FILE=/run/secrets/resolver_key
ORACLE_API_KEYS_FILE=/run/secrets/oracle_api_keys
WEBHOOK_SIGNING_SECRET_FILE=/run/secrets/webhook_signing_secret
```

### Safety Rules:
1. Setting both `<NAME>` and `<NAME>_FILE` causes a startup validation error to prevent configuration ambiguity.
2. In production (`NODE_ENV=production`), services fail fast with clear diagnostic messages if required credentials are unset or empty.
