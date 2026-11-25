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

How a breaking change is shipped and announced, and how releases are versioned,
is in [Releasing and Versioning](RELEASING.md#api-versioning-and-breaking-changes).

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

