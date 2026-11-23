#!/usr/bin/env node
/**
 * Runs every worked example in docs/API_EXAMPLES.md against a live instance and
 * fails (exit 1) on the first mismatch. Examples that are never run teach broken
 * patterns, so this script is the proof that they work.
 *
 * Usage:
 *   IPREDICT_API_URL=http://127.0.0.1:4000 node examples/verify-examples.mjs
 *
 * Expects a running API backed by a migrated database. The seed script
 * (db/seed.ts) provides markets for the pagination checks. Checks assert shape
 * and invariants rather than exact counts, so they work on any instance.
 *
 * The rate-limit check deliberately exhausts the anonymous budget for
 * GET /api/markets (60 requests per 60s). It can take up to a minute to recover.
 */
import {
  DEFAULT_BASE_URL,
  ApiError,
  MAX_PAGINATION_LIMIT,
  MAX_PAGINATION_OFFSET,
  apiGet,
  clearResponseCache,
  getStats,
  isHealthy,
  iterateMarkets,
  listAllMarkets,
  listAllPlayers,
  listMarketsPage,
} from "./ipredict-client.mjs";

const baseUrl = DEFAULT_BASE_URL;
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    console.error(`\n${passed} passed before this failure.`);
    process.exit(1);
  }
}

async function expectApiError(promise, status, code) {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert(err.status === status, `expected HTTP ${status}, got ${err.status}`);
    assert(err.code === code, `expected code ${code}, got ${err.code}`);
    return;
  }
  throw new Error(`expected HTTP ${status} ${code}, but the request succeeded`);
}

console.log(`Verifying API examples against ${baseUrl}\n`);
clearResponseCache();

// ── Task 1: health and conditional requests ──────────────────────────────────

await check("liveness: /healthz reports ok", async () => {
  assert(await isHealthy(baseUrl), "healthz did not return status ok");
});

await check("conditional GET: first call is 200 with an ETag and a body", async () => {
  const first = await getStats(baseUrl);
  assert(first.status === 200, `expected 200, got ${first.status}`);
  assert(first.fromCache === false, "first call should not come from cache");
  assert(first.data && typeof first.data === "object", "stats body missing");
});

await check("conditional GET: second call sends If-None-Match and reuses the body on 304", async () => {
  const first = await getStats(baseUrl);
  const second = await getStats(baseUrl);
  assert(second.status === 304, `expected 304, got ${second.status}`);
  assert(second.fromCache === true, "304 should return the cached body");
  assert(JSON.stringify(second.data) === JSON.stringify(first.data), "cached body differs");
});

// ── Task 2: pagination and boundary conditions ───────────────────────────────

await check("pagination: walking pages with limit=2 returns every market exactly once", async () => {
  const everything = await listAllMarkets({ baseUrl, filter: "all", limit: 2 });
  const ids = everything.map((m) => m.id);
  assert(new Set(ids).size === ids.length, "a market appeared on two pages");

  const first = await listMarketsPage({ baseUrl, filter: "all", page: 1, limit: MAX_PAGINATION_LIMIT });
  assert(first.data.total === everything.length, `total ${first.data.total} != walked ${everything.length}`);
});

await check("pagination: iterateMarkets stops after the last partial page", async () => {
  const { data } = await listMarketsPage({ baseUrl, filter: "all", page: 1, limit: 1 });
  let count = 0;
  for await (const _ of iterateMarkets({ baseUrl, filter: "all", limit: 1 })) count += 1;
  assert(count === data.total, `iterated ${count}, total is ${data.total}`);
});

await check("boundary: a page past the last one is 200 with an empty array", async () => {
  const { data: first } = await listMarketsPage({ baseUrl, filter: "all", page: 1, limit: 1 });
  const pastEnd = first.total + 1;
  const { status, data } = await apiGet("/api/markets", {
    baseUrl,
    query: { filter: "all", page: pastEnd, limit: 1 },
  });
  assert(status === 200, `expected 200, got ${status}`);
  assert(Array.isArray(data.markets) && data.markets.length === 0, "expected an empty page");
  assert(data.total === first.total, "total must not change for an empty page");
});

await check("boundary: limit above the maximum is rejected with 400", async () => {
  await expectApiError(
    listMarketsPage({ baseUrl, limit: MAX_PAGINATION_LIMIT + 1 }),
    400,
    "BAD_REQUEST",
  );
});

await check("boundary: page 0 is rejected with 400", async () => {
  await expectApiError(listMarketsPage({ baseUrl, page: 0, limit: 1 }), 400, "BAD_REQUEST");
});

await check("boundary: an offset above the maximum is rejected with 400, not truncated", async () => {
  // With limit=1, page MAX_PAGINATION_OFFSET + 2 gives offset MAX_PAGINATION_OFFSET + 1.
  await expectApiError(
    listMarketsPage({ baseUrl, page: MAX_PAGINATION_OFFSET + 2, limit: 1 }),
    400,
    "BAD_REQUEST",
  );
});

await check("client: iterateMarkets rejects a limit above the maximum before any request", async () => {
  let threw = false;
  try {
    await iterateMarkets({ baseUrl, limit: MAX_PAGINATION_LIMIT + 1 }).next();
  } catch (err) {
    threw = err instanceof RangeError;
  }
  assert(threw, "expected a RangeError for an oversized limit");
});

// ── Task 3: errors and a single resource ─────────────────────────────────────

await check("errors: an unknown filter is rejected with 400 and a requestId", async () => {
  try {
    await apiGet("/api/markets", { baseUrl, query: { filter: "bogus" } });
  } catch (err) {
    assert(err.status === 400, `expected 400, got ${err.status}`);
    assert(typeof err.body?.error?.requestId === "string", "requestId missing");
    return;
  }
  throw new Error("expected a 400 for an unknown filter");
});

await check("errors: a missing market is 404 NOT_FOUND", async () => {
  await expectApiError(apiGet("/api/markets/999999999", { baseUrl }), 404, "NOT_FOUND");
});

await check("market detail: an id from the list loads", async () => {
  const [sample] = (await listMarketsPage({ baseUrl, filter: "all", page: 1, limit: 1 })).data.markets;
  if (!sample) {
    console.log("    (no markets on this instance; skipped detail lookup)");
    return;
  }
  const { status, data } = await apiGet(`/api/markets/${sample.id}`, { baseUrl });
  assert(status === 200, `expected 200, got ${status}`);
  assert(data.id === sample.id, "returned a different market");
});

await check("leaderboard: offset pagination collects players without duplicates", async () => {
  const players = await listAllPlayers({ baseUrl, limit: 2 });
  const addresses = players.map((p) => p.address);
  assert(new Set(addresses).size === addresses.length, "a player appeared twice");
});

// ── Rate limits ───────────────────────────────────────────────────────────────

await check("rate limit: a burst gets 429 with Retry-After, and the client recovers", async () => {
  let limited = null;
  for (let i = 0; i < 80 && !limited; i += 1) {
    const res = await fetch(`${baseUrl}/api/markets?limit=1&sort=volume`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 429) limited = res;
  }
  assert(limited, "no 429 after 80 requests; is the anonymous budget higher here?");
  assert(limited.headers.get("retry-after") !== null, "429 is missing Retry-After");
  assert(limited.headers.get("x-ratelimit-remaining") === "0", "remaining should be 0 on 429");

  // apiGet waits for Retry-After and retries, so this succeeds once the window resets.
  const recovered = await apiGet("/api/markets", { baseUrl, query: { limit: 1 }, useCache: false });
  assert(recovered.status === 200, `expected 200 after waiting, got ${recovered.status}`);
});

console.log(`\nAll ${passed} example checks passed.`);
