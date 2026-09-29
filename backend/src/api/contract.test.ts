import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createFakePool } from "../test/fakePool.js";
import { detectDroppedFields, getOpenApiSpec, validateResponseAgainstSpec } from "./contract-helpers.js";
import { classifyFastifyRoutes, assertAllRoutesClassified, PUBLIC_ROUTES, PROTECTED_ROUTES } from "./index.js";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
// Exercise the real query modules, including routes that use the default pool.
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  return { ...actual, Pool: class {
    query = mocks.query;
    on() {}
    async end() {}
    async connect() { return { query: mocks.query, release() {} }; }
  } };
});
vi.mock("../db/redis.js", async importOriginal => ({
  ...await importOriginal<typeof import("../db/redis.js")>(),
  pingRedis: vi.fn(async () => ({ ok: true })),
}));
import { buildServer } from "../server.js";

const address = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const market = { id: 1, question: "Will XLM reach $1?", image_url: null, category: "Crypto", end_time: "1770000000", total_yes: "10.0000000", total_no: "5.0000000", resolved: false, outcome: null, cancelled: false, creator: address, bet_count: 1, created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-02T00:00:00Z") };
const bet = { market_id: "1", bettor: address, net_amount: "9.8000000", gross_amount: "10.0000000", is_yes: true, claimed: false, created_at: new Date("2026-01-01T00:00:00Z") };
const leader = { address, display_name: null, points: "350", won_bets: 2, lost_bets: 1, updated_at: new Date("2026-01-01T00:00:00Z") };
function queryRows(sql: string, values?: unknown[]) {
  if (sql.includes("pg_backend_pid")) return [{ pid: 123 }];
  if (sql.includes("AS total_markets")) return [{ total_markets: "1", total_volume: "15.0000000", total_users: "1", total_bets: "1" }];
  if (/COUNT\(\*\)/.test(sql) && !sql.includes("OVER")) return [{ total: "1" }];
  if (sql.includes("SELECT id::TEXT")) return [{ id: "1", question: market.question, category: market.category, end_time: market.end_time }];
  if (sql.includes("FROM markets")) {
    if (/WHERE id\s*=/.test(sql) && Number(values?.[0]) === 999) return [];
    return [{ ...market, ...(sql.includes("total_count") ? { total_count: 1 } : {}) }];
  }
  if (sql.includes("FROM bets")) return [bet];
  if (sql.includes("FROM leaderboard")) return [leader];
  if (sql.includes("FROM events")) return [];
  if (sql.trim() === "SELECT 1") return [{ "?column?": 1 }];
  throw new Error(`Unexpected query: ${sql}`);
}

const cases: { method: "GET" | "POST"; url: string; path: string; status: number }[] = [
  ...["/api/docs", "/healthz", "/readyz", "/resolution-status", "/status", "/api/markets", "/api/markets/resolution-status", "/api/markets/unmappable", "/api/leaderboard", "/api/stats"].map(path => ({ method: "GET" as const, url: path, path, status: 200 })),
  ...["", "/bets", "/odds"].map(suffix => ({ method: "GET" as const, url: `/api/markets/1${suffix}`, path: `/api/markets/{id}${suffix}`, status: 200 })),
  { method: "GET", url: `/api/v1/profile/${address}`, path: "/api/v1/profile/{address}", status: 200 },
  ...["/api/oracle/submit", "/api/v1/oracle/submit"].map(path => ({ method: "POST" as const, url: path, path, status: 401 })),
];
let app: FastifyInstance;
let rawPayload: unknown;
beforeEach(() => {
  mocks.query.mockReset().mockImplementation(async (sql: string, values?: unknown[]) => ({ rows: queryRows(sql, values) }));
  app = buildServer({ pool: createFakePool(mocks.query), corsOrigins: [], logger: false });
  rawPayload = undefined;
  app.addHook("preSerialization", async (_request, _reply, payload) => {
    rawPayload = structuredClone(payload);
    return payload;
  });
});
afterEach(async () => { await app.close(); });

function assertPreservedFields(raw: unknown, serialized: unknown) {
  expect(detectDroppedFields(raw, serialized).droppedFields).toEqual([]);
}

async function assertContract(options: InjectOptions, path: string, status: number) {
  const spec = await getOpenApiSpec(app);
  const response = await app.inject(options);
  expect(response.statusCode, response.body).toBe(status);
  const result = validateResponseAgainstSpec(spec, String(options.method ?? "GET"), path, status, response.json());
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
  expect(rawPayload).toBeDefined();
  assertPreservedFields(rawPayload, response.json());
  return response;
}

describe("OpenAPI contracts on the production server", () => {
  it("covers every documented and registered operation", async () => {
    const spec = await getOpenApiSpec(app);
    const tested = cases.map(c => `${c.method.toLowerCase()} ${c.path}`).sort();
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods as object).map(method => `${method} ${path}`)).sort();
    expect(documented).toEqual(tested);
    expect(app.registeredRoutes.map(({ method, url }) => `${method.toLowerCase()} ${url.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`).sort()).toEqual(tested);
  });
  it.each(cases)("$method $url returns a valid $status response without dropped fields", async ({ method, url, path, status }) => {
    await assertContract({ method, url, ...(method === "POST" ? { payload: { marketId: 1, outcome: "YES", signature: "invalid", provider: address } } : {}) }, path, status);
  });
  it.each([
    ["/api/markets?page=-1", "/api/markets", 400],
    ["/api/markets/invalid", "/api/markets/{id}", 400],
    ["/api/markets/999", "/api/markets/{id}", 404],
    ["/api/markets/999/bets", "/api/markets/{id}/bets", 404],
    ["/api/v1/profile/invalid", "/api/v1/profile/{address}", 400],
  ] as const)("validates real error response %s", async (url, path, status) => {
    await assertContract({ method: "GET", url }, path, status);
  });
  it("validates readiness failure against the declared 503 response", async () => {
    mocks.query.mockRejectedValue(new Error("Database unavailable"));
    await assertContract({ method: "GET", url: "/readyz" }, "/readyz", 503);
  });
  it.each(["/api/markets", "/api/markets/1", "/api/markets/1/bets"])("detects a new database field silently removed from %s", async url => {
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => ({ rows: queryRows(sql, values).map(row => ({ ...row, new_public_field: "must survive" })) }));
    const response = await app.inject(url);
    expect(response.statusCode, response.body).toBe(200);
    expect(detectDroppedFields(rawPayload, response.json()).droppedFields).toEqual(expect.arrayContaining([expect.stringContaining("new_public_field")]));
    expect(() => assertPreservedFields(rawPayload, response.json())).toThrow();
  });
});

describe("Route authentication registry and enforcement (#548)", () => {
  it("covers and classifies every registered Fastify route as protected or public", async () => {
    await app.ready();
    const result = classifyFastifyRoutes(app.registeredRoutes);
    expect(result.unclassified).toEqual([]);
    expect(result.unregistered).toEqual([]);
    expect(result.classified.length).toBe(app.registeredRoutes.length);
    assertAllRoutesClassified(app.registeredRoutes);
  });

  it("fails when an unclassified route is present in the route list", async () => {
    await app.ready();
    const unclassifiedRoutes = [
      ...app.registeredRoutes,
      { method: "POST", url: "/api/v1/unprotected/action" },
    ];
    const result = classifyFastifyRoutes(unclassifiedRoutes);
    expect(result.unclassified).toEqual([
      {
        method: "POST",
        url: "/api/v1/unprotected/action",
        canonicalKey: "POST /api/v1/unprotected/action",
      },
    ]);
    expect(() => assertAllRoutesClassified(unclassifiedRoutes)).toThrowError(
      /Unclassified route\(s\) detected on Fastify instance/
    );
  });

  it("fails when a new unclassified route is dynamically registered on a Fastify instance", async () => {
    const testApp = buildServer({ pool: createFakePool(mocks.query), corsOrigins: [], logger: false });
    testApp.post("/api/new-unclassified-endpoint", async () => ({ ok: true }));
    await testApp.ready();

    expect(() => assertAllRoutesClassified(testApp.registeredRoutes)).toThrowError(
      /POST \/api\/new-unclassified-endpoint/
    );
    await testApp.close();
  });

  it("public routes are explicitly listed as intentional with documented reasons", () => {
    expect(PUBLIC_ROUTES.length).toBeGreaterThan(0);
    for (const route of PUBLIC_ROUTES) {
      expect(route.auth).toBe("public");
      expect(typeof route.reason).toBe("string");
      expect(route.reason.trim().length).toBeGreaterThan(15);
    }
  });

  it("every protected route is verified to reject unauthenticated requests with 401 Unauthorized", async () => {
    expect(PROTECTED_ROUTES.length).toBeGreaterThan(0);
    for (const route of PROTECTED_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        payload: { marketId: 1, outcome: "YES", signature: "invalid", provider: address },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toHaveProperty("code");
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("every protected route also rejects requests carrying an invalid API key", async () => {
    for (const route of PROTECTED_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: {
          authorization: "Bearer invalid-dummy-key",
        },
        payload: { marketId: 1, outcome: "YES", signature: "invalid", provider: address },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("verifies all public routes allow unauthenticated access without 401/403 rejections", async () => {
    for (const route of PUBLIC_ROUTES) {
      let testUrl = route.url;
      if (testUrl.includes(":id")) testUrl = testUrl.replace(":id", "1");
      if (testUrl.includes(":address")) testUrl = testUrl.replace(":address", address);

      const response = await app.inject({
        method: route.method,
        url: testUrl,
      });
      expect([401, 403]).not.toContain(response.statusCode);
      expect(response.statusCode).toBe(200);
    }
  });
});

