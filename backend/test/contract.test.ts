import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/server";
import { getOpenApiSpec, validateResponseAgainstSpec, detectDroppedFields } from "../src/api/openapi";
import type { Queryable } from "../src/db/markets";

const market = { id: 1, question: "Will XLM reach $1?", image_url: null, category: "Crypto", end_time: "1770000000", total_yes: "10", total_no: "5", resolved: false, outcome: null, cancelled: false, creator: "GCREATOR", bet_count: 1, created_at: new Date("2026-01-01Z"), updated_at: new Date("2026-01-02Z") };
const bet = { market_id: "1", bettor: "GBETTOR", net_amount: "9.8", gross_amount: "10", is_yes: true, claimed: false, created_at: new Date("2026-01-01Z") };
const leader = { address: "GBETTOR", display_name: null, points: "350", won_bets: 2, lost_bets: 1, updated_at: new Date("2026-01-01Z") };

function queryRows(sql: string, values?: unknown[]) {
  if (sql.includes("COUNT(*)")) return [{ total: 1 }];
  if (sql.includes("FROM markets")) return sql.includes("WHERE id") && values?.[0] === "999" ? [] : [market];
  if (sql.includes("FROM bets")) return [bet];
  if (sql.includes("FROM leaderboard")) return [leader];
  throw new Error(`Unexpected SQL: ${sql}`);
}

// Every successful response is compared to its actual handler output, before serialization.
function observePayloads(app: FastifyInstance) {
  const payloads = new Map<string, unknown>();
  app.addHook("preSerialization", async (request, _reply, payload) => {
    payloads.set(request.id, structuredClone(payload));
    return payload;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const raw = payloads.get(request.id);
    payloads.delete(request.id);
    if (reply.statusCode < 300 && typeof payload === "string") {
      expect(raw).toBeDefined();
      expect(detectDroppedFields(raw, JSON.parse(payload)).droppedFields).toEqual([]);
    }
    return payload;
  });
}

const successCases = [
  ["/health", "/health"],
  ["/api/v1/markets?page=2&limit=10", "/api/v1/markets"],
  ["/api/v1/markets/1", "/api/v1/markets/{id}"],
  ["/api/v1/bets?marketId=1&bettor=GBETTOR", "/api/v1/bets"],
  ["/api/v1/leaderboard", "/api/v1/leaderboard"],
] as const;

describe("Shared API contracts", () => {
  let app: FastifyInstance;
  let spec: any;
  const query = vi.fn(async (sql: string, values?: unknown[]) => ({ rows: queryRows(sql, values) }));
  beforeAll(async () => {
    app = await createApiServer({ query: query as Queryable["query"] });
    observePayloads(app);
    spec = await getOpenApiSpec(app);
  });
  afterAll(async () => { await app.close(); });

  it("covers every documented operation", () => {
    const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.keys(item as object).filter(method => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method)).map(method => `${method} ${path}`));
    expect(operations.sort()).toEqual(successCases.map(([, path]) => `get ${path}`).sort());
  });
  it.each(successCases)("validates success and preserves handler fields: %s", async (url, path) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode, res.body).toBe(200);
    expect(validateResponseAgainstSpec(spec, "GET", path, res.statusCode, res.json())).toEqual({ valid: true, errors: [], schemaFound: true });
  });
  it("passes filters and pagination to the database", async () => {
    await app.inject("/api/v1/markets?page=2&limit=10&category=Crypto");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("LIMIT"), ["Crypto", 10, 10]);
  });
  it.each([
    ["/api/v1/markets?page=-1", "/api/v1/markets", 400],
    ["/api/v1/markets/invalid", "/api/v1/markets/{id}", 400],
    ["/api/v1/markets/999", "/api/v1/markets/{id}", 404],
    ["/api/v1/bets?marketId=invalid", "/api/v1/bets", 400],
  ])("validates actual error: %s", async (url, path, status) => {
    const res = await app.inject(String(url));
    expect(res.statusCode).toBe(status);
    expect(validateResponseAgainstSpec(spec, "GET", String(path), res.statusCode, res.json()).valid).toBe(true);
  });
  it.each(successCases.slice(1))("validates database failure: %s", async (url, path) => {
    const failing = await createApiServer({ query: async () => { throw new Error("Database unavailable"); } });
    try {
      const failureSpec = await getOpenApiSpec(failing);
      const res = await failing.inject(url);
      expect(res.statusCode).toBe(500);
      expect(validateResponseAgainstSpec(failureSpec, "GET", path, 500, res.json()).valid).toBe(true);
    } finally { await failing.close(); }
  });
  it.each(successCases.slice(1))("fails the contract when a database field is omitted: %s", async (url) => {
    const mutated = await createApiServer({ query: (async (sql: string, values?: unknown[]) => ({ rows: queryRows(sql, values).map(row => ({ ...row, new_public_field: "must survive" })) })) as Queryable["query"] });
    observePayloads(mutated);
    try {
      const res = await mutated.inject(url);
      // The same guard used by success tests turns the omission into a failed response.
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toContain("newPublicField");
    } finally { await mutated.close(); }
  });
});

describe("Contract helpers", () => {
  it("detects nested omissions, array items, null and ignores undefined", () => {
    expect(detectDroppedFields({ markets: [{ id: "1", extra: true }], absent: undefined }, { markets: [{ id: "1" }] }).droppedFields).toEqual(["markets[0].extra"]);
    expect(detectDroppedFields({ nested: { id: 1 } }, { nested: null }).droppedFields).toEqual(["nested.id"]);
    expect(detectDroppedFields({ id: 1 }, null).droppedFields).toEqual(["id"]);
  });
  it("does not accept inherited properties as serialized fields", () => {
    expect(detectDroppedFields({ toString: "value" }, {}).droppedFields).toEqual(["toString"]);
  });
  const spec = { paths: { "/example": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Example" } } } } } } } }, components: { schemas: {
    Example: { type: "object", required: ["child"], properties: { child: { $ref: "#/components/schemas/Child" } } },
    Child: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
  } } };
  it("resolves component references including nested references on repeated calls", () => {
    for (let i = 0; i < 2; i++) expect(validateResponseAgainstSpec(spec, "GET", "/example", 200, { child: { id: "1" } }).valid).toBe(true);
    expect(validateResponseAgainstSpec(spec, "GET", "/example", 200, { child: {} }).valid).toBe(false);
    expect(validateResponseAgainstSpec(spec, "GET", "/example", 200, { child: { id: 1 } }).valid).toBe(false);
  });
  it("rejects undocumented paths and statuses", () => {
    expect(validateResponseAgainstSpec(spec, "GET", "/missing", 200, {}).schemaFound).toBe(false);
    expect(validateResponseAgainstSpec(spec, "GET", "/example", 201, {}).schemaFound).toBe(false);
  });
});
