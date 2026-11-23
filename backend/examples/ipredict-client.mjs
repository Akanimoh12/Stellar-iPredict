/**
 * Minimal, dependency-free iPredict API client used by the worked examples in
 * docs/API_EXAMPLES.md. Requires Node.js >= 20 (global `fetch`).
 *
 * Covers the three things integrators most often get wrong:
 *   1. Conditional GETs — remember the ETag and the body, send If-None-Match,
 *      and treat 304 as "use the body you already have", not as an empty result.
 *   2. Rate limits — on 429, wait for Retry-After (or X-RateLimit-Reset) and retry
 *      a bounded number of times instead of hammering the endpoint.
 *   3. Pagination — stop on the last partial page, an empty page, or the total,
 *      and never request an offset above the server's maximum.
 *
 * Every function here is exercised by examples/verify-examples.mjs against a
 * live instance, so if the API changes, the verification fails.
 */

export const DEFAULT_BASE_URL = process.env.IPREDICT_API_URL ?? "http://127.0.0.1:4000";

// Mirror of backend/src/lib/pagination.ts. Keep in sync; verify-examples.mjs
// checks the boundary behaviour these constants describe.
export const MAX_PAGINATION_LIMIT = 100;
export const MAX_PAGINATION_OFFSET = 10_000;

/** Longest we will sleep on a single 429 before giving up. */
const MAX_RETRY_WAIT_MS = 65_000;

export class ApiError extends Error {
  constructor(status, body, headers) {
    const code = body?.error?.code ?? "UNKNOWN";
    const message = body?.error?.message ?? `HTTP ${status}`;
    super(`${status} ${code}: ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.headers = headers;
  }
}

/**
 * Responses we have seen for a URL, keyed by the full URL including the query
 * string. The ETag is only valid for that exact URL, so the key must include it.
 */
const responseCache = new Map();

export function clearResponseCache() {
  responseCache.clear();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait after a 429, from Retry-After, falling back to X-RateLimit-Reset. */
export function retryAfterMs(response, now = Date.now()) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - now, 0), MAX_RETRY_WAIT_MS);
  }
  return 1000;
}

/**
 * GET a JSON endpoint with conditional-request and rate-limit handling.
 *
 * Returns `{ status, data, fromCache }`. `fromCache` is true when the server
 * answered 304 and we returned the body we stored earlier.
 *
 * Throws ApiError for any non-2xx response other than a 429 we can retry.
 */
export async function apiGet(path, {
  baseUrl = DEFAULT_BASE_URL,
  query = {},
  useCache = true,
  maxRetries = 3,
} = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const cacheKey = url.toString();
  const cached = useCache ? responseCache.get(cacheKey) : undefined;

  for (let attempt = 0; ; attempt += 1) {
    const headers = { Accept: "application/json" };
    if (cached) headers["If-None-Match"] = cached.etag;

    const response = await fetch(url, { headers });

    if (response.status === 304) {
      if (!cached) {
        // Only possible if the server sent a 304 we did not ask for. Surface it.
        throw new ApiError(304, null, response.headers);
      }
      return { status: 304, data: cached.body, fromCache: true };
    }

    if (response.status === 429 && attempt < maxRetries) {
      await sleep(retryAfterMs(response));
      continue;
    }

    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new ApiError(response.status, body, response.headers);
    }

    const etag = response.headers.get("etag");
    if (etag) responseCache.set(cacheKey, { etag, body });

    return { status: response.status, data: body, fromCache: false };
  }
}

// ── Task 1: health and a conditional request ──────────────────────────────────

/** Liveness check. Returns true when the API reports ok. */
export async function isHealthy(baseUrl = DEFAULT_BASE_URL) {
  const { data } = await apiGet("/healthz", { baseUrl, useCache: false });
  return data?.status === "ok";
}

/**
 * Platform stats with ETag support. The first call downloads the body; later
 * calls send If-None-Match and reuse the stored body on 304.
 */
export async function getStats(baseUrl = DEFAULT_BASE_URL) {
  return apiGet("/api/stats", { baseUrl });
}

// ── Task 2: list markets and page through all of them ─────────────────────────

/**
 * Yields every market matching the filters, one page at a time.
 *
 * Stops when any of these holds:
 *   • a page comes back empty,
 *   • a page is shorter than `limit` (that was the last page),
 *   • the number of markets seen reaches `total`,
 *   • the next page's offset would exceed MAX_PAGINATION_OFFSET.
 *
 * The last case is a hard limit, not a bug: deeper results need narrower filters.
 * Markets created while you page can shift later pages, so de-duplicate by `id`
 * if you need an exact set.
 */
export async function* iterateMarkets({
  baseUrl = DEFAULT_BASE_URL,
  filter = "all",
  sort = "newest",
  category,
  limit = 20,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGINATION_LIMIT) {
    throw new RangeError(`limit must be an integer 1..${MAX_PAGINATION_LIMIT}`);
  }

  let page = 1;
  let seen = 0;

  for (;;) {
    const offset = (page - 1) * limit;
    if (offset > MAX_PAGINATION_OFFSET) {
      throw new RangeError(
        `offset ${offset} exceeds the maximum ${MAX_PAGINATION_OFFSET}; narrow the filters instead`,
      );
    }

    const { data } = await apiGet("/api/markets", {
      baseUrl,
      query: { filter, sort, category, page, limit },
    });

    for (const market of data.markets) {
      seen += 1;
      yield market;
    }

    const isEmpty = data.markets.length === 0;
    const isLastPartialPage = data.markets.length < limit;
    const reachedTotal = seen >= data.total;
    if (isEmpty || isLastPartialPage || reachedTotal) return;

    page += 1;
  }
}

/** Collects every page into one array, de-duplicated by market id. */
export async function listAllMarkets(options = {}) {
  const byId = new Map();
  for await (const market of iterateMarkets(options)) {
    byId.set(market.id, market);
  }
  return [...byId.values()];
}

/**
 * Lists one page with ETag caching. Use this when a UI polls the first page:
 * an unchanged page costs a 304 with no body. The cache is keyed by URL, so
 * different filters or pages never share an ETag.
 */
export async function listMarketsPage({ baseUrl = DEFAULT_BASE_URL, ...query } = {}) {
  return apiGet("/api/markets", { baseUrl, query });
}

// ── Task 3: leaderboard with offset pagination ────────────────────────────────

/** Collects the leaderboard by offset, stopping at the total or the offset cap. */
export async function listAllPlayers({
  baseUrl = DEFAULT_BASE_URL,
  sort = "points",
  limit = 20,
} = {}) {
  const players = [];
  let offset = 0;

  for (;;) {
    if (offset > MAX_PAGINATION_OFFSET) {
      throw new RangeError(`offset ${offset} exceeds the maximum ${MAX_PAGINATION_OFFSET}`);
    }
    const { data } = await apiGet("/api/leaderboard", {
      baseUrl,
      query: { sort, offset, limit },
    });
    players.push(...data.players);
    offset += limit;
    if (data.players.length < limit || offset >= data.total) return players;
  }
}
