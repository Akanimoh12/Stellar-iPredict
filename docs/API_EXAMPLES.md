# API client examples

Worked examples for the common integration tasks against the iPredict REST API:
listing markets, paging through them, using ETags correctly, handling rate limits
and reading errors. The reference for every endpoint is the OpenAPI document at
`GET /api/docs`. This page shows how to put those endpoints together.

Every example here is implemented in
[`backend/examples/ipredict-client.mjs`](../backend/examples/ipredict-client.mjs)
and checked against a live instance by
[`backend/examples/verify-examples.mjs`](../backend/examples/verify-examples.mjs).
If an example stops matching the API, that script fails.

The client needs Node.js 20 or later and has no dependencies.

```js
import * as ipredict from "./backend/examples/ipredict-client.mjs";
// or set IPREDICT_API_URL=https://api.example.com to point at another instance
```

## Running the verification

```bash
# 1. Start Postgres and Redis, then migrate and seed the database
cd infra && docker compose -f docker-compose.dev.yml up -d && cd ..
cd db && npm run migrate && npm run seed && cd ..

# 2. Configure and start the API (the backend has no `dev` script yet; see note below)
cd backend && cp .env.example .env   # set DATABASE_URL and REDIS_URL to match step 1
npm run build; set -a; . ./.env; set +a; node dist/src/index.js &

# 3. Run every example against it
IPREDICT_API_URL=http://127.0.0.1:4000 npm run examples:verify
```

Expect `All 15 example checks passed.` The run takes about a minute, because the
rate-limit check waits for the window to reset.

> **Note.** `backend/README.md` says `npm run dev`, but the backend has no `dev`
> script. `npm run build` also fails on one unrelated test-file type error (see
> the backend typecheck). The compiled `dist/src/index.js` still emits and runs
> once the environment is loaded (the `set -a; . ./.env; set +a` line above).

---

## 1. Check the API is up

```js
const healthy = await ipredict.isHealthy("https://api.example.com");
```

`GET /healthz` returns `{ "status": "ok" }`. `GET /readyz` also checks the database
and Redis, and is the one to use for readiness.

## 2. Use ETags so unchanged data costs a 304

Responses from `GET /api/markets`, `GET /api/leaderboard` and `GET /api/stats`
include a strong `ETag`. Send it back in `If-None-Match`. If nothing has changed,
the server answers `304 Not Modified` with no body.

**Pattern:** keep the body that came with the `200`, keyed by URL, and when you get
a `304` return that stored body. A `304` has no body, so reading `await res.json()`
on it fails or returns nothing.

```js
const stats = await ipredict.getStats(baseUrl);
// stats.status === 200 the first time, 304 later if nothing changed
// stats.fromCache === true on a 304; stats.data is the stored body either way
```

Things to avoid:

- **Do not share one ETag across URLs.** The ETag is for one exact URL, including its
  query string. `?page=1` and `?page=2` have different ETags. The client keys its
  cache by the full URL.
- **Do not treat a 304 as "no markets".** It means "the body you already have is
  still current".
- **Do not send `If-None-Match` for a page you have never fetched.** You will get a
  304 with nothing stored to return. The client only sends it when it has a stored
  ETag.

`GET /api/markets` also sends `Cache-Control: public, max-age=30` (15 seconds for
`filter=active`). Respect that before you poll again.

## 3. List active markets

```js
const { data } = await ipredict.listMarketsPage({
  baseUrl,
  filter: "active",   // active | resolved | ended | cancelled | all
  sort: "ending_soon", // newest | volume | ending_soon | bettors
  category: "Crypto",  // optional; one of the five categories
  page: 1,
  limit: 20,           // 1..100, default 20
});
// data: { markets: [...], total, page, limit }
```

`total` is the number of matching markets across all pages, not the length of this
page.

## 4. Page through every market

```js
for await (const market of ipredict.iterateMarkets({ baseUrl, filter: "all", limit: 50 })) {
  console.log(market.id, market.question);
}

// Or collect them, de-duplicated by id:
const everything = await ipredict.listAllMarkets({ baseUrl, filter: "all" });
```

The iterator stops when any of these is true:

| Condition | Why it stops |
|---|---|
| A page is empty | There is nothing past it. |
| A page has fewer than `limit` items | That was the last, partial page. |
| The count seen reaches `total` | Every match has been returned. |
| The next offset would exceed 10 000 | The server refuses it. See below. |

**Boundary conditions the examples cover:**

- **Past the last page** returns `200` with `"markets": []` and the same `total`. It
  is not an error.
- **`page=0`** and **`limit` above 100** return `400 BAD_REQUEST`.
- **Offset cap.** `(page - 1) × limit` must not exceed **10 000**. A request above
  that returns `400 BAD_REQUEST` ("use cursor-based pagination for deeper results").
  The server does not truncate it. If your filters match more than 10 000 markets,
  narrow them with `filter` or `category`.
- **Changing data.** Markets created between pages can shift later pages, so one
  market can appear twice or be missed. De-duplicate by `id`, or accept that the
  result is a snapshot of each page.

## 5. Handle rate limits

Anonymous requests are limited per IP. Each route has its own budget, for example
**60 requests per 60 seconds** for `GET /api/markets`. Responses include:

- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (a Unix time)
- on `429`, `Retry-After` (seconds)

Requests that present a key listed in the server's `API_KEYS` setting (as
`Authorization: Bearer <key>`, `Authorization: Api-Key <key>` or `X-API-Key`) get a
higher budget, 120 per minute for `GET /api/markets`. An unrecognised token is treated
as anonymous, so it does not raise the limit. Ask the operator for a key.

**Pattern:** on `429`, wait `Retry-After` seconds and retry a few times. Do not retry
immediately. The client does this for you:

```js
const { data } = await ipredict.apiGet("/api/markets", {
  baseUrl,
  query: { filter: "active" },
  maxRetries: 3, // waits Retry-After (or X-RateLimit-Reset) between attempts
});
```

If you still get `429` after the retries, the `ApiError` carries the headers, so you
can back off further.

## 6. Read the leaderboard

```js
const players = await ipredict.listAllPlayers({ baseUrl, sort: "points", limit: 20 });
```

`GET /api/leaderboard` uses `offset` and `limit`, with the same 10 000 offset cap. It
stops when a page is short or `offset` reaches `total`.

## 7. Handle errors

Every error body has this shape:

```json
{ "error": { "code": "BAD_REQUEST", "message": "...", "requestId": "..." } }
```

Log `requestId`. It matches the `x-request-id` response header and the server log line,
so it is the first thing support will ask for.

```js
try {
  await ipredict.apiGet(`/api/markets/${id}`, { baseUrl });
} catch (err) {
  if (err instanceof ipredict.ApiError && err.status === 404) {
    // err.code === "NOT_FOUND": the market does not exist
  } else {
    throw err;
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Bad query or path parameter. The message says which one. |
| 404 | `NOT_FOUND` | No such resource. |
| 429 | (rate limited) | Wait `Retry-After` seconds. |
| 304 | (none) | Not modified. Only meaningful with `If-None-Match`. |

---

## Keeping these examples current

- `npm run examples:verify` runs all of the checks above against a live instance. Run
  it after any change to the markets, leaderboard or rate-limit code.
- `backend/src/lib/pagination.ts` holds the limits (`MAX_PAGINATION_LIMIT` = 100,
  `MAX_PAGINATION_OFFSET` = 10 000). The client copies them. If you change them,
  change `backend/examples/ipredict-client.mjs` too; the boundary checks will fail
  if you do not.
- The rate-limit numbers in this document come from `backend/src/config/rateLimits.ts`.
