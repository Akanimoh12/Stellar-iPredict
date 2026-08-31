import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  computeEtag,
  createMarketsRoutes,
  matchesIfNoneMatch,
  parsePositiveInteger
} from "./markets";
import { registerErrorHandler } from "../lib/errors.js";
import type { MarketRow, Queryable } from "../db/markets.js";

function createMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 42,
    question: "Will XLM close above $1 by year end?",
    image_url: null,
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "10.0000000",
    total_no: "5.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    bet_count: 3,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

async function buildTestServer(db: Queryable) {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  createMarketsRoutes(server, db);
  await server.ready();
  return server;
}

function createListDb(markets: MarketRow[]): Queryable {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("COUNT")) {
        return { rows: [{ total: markets.length }] };
      }
      return { rows: markets };
    }) as Queryable["query"]
  };
}

describe("parsePositiveInteger", () => {
  it("accepts positive integers", () => {
    expect(parsePositiveInteger("1")).toBe(1);
    expect(parsePositiveInteger("42")).toBe(42);
  });

  it("rejects invalid ids", () => {
    expect(parsePositiveInteger("0")).toBeNull();
    expect(parsePositiveInteger("-1")).toBeNull();
    expect(parsePositiveInteger("1.5")).toBeNull();
    expect(parsePositiveInteger("abc")).toBeNull();
  });
});

describe("GET /api/markets/resolution-status (issue #645)", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("reports on_time when nothing is overdue", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({ method: "GET", url: "/api/markets/resolution-status" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("on_time");
    expect(body.overdueMarkets).toBe(0);
    expect(body.oldestOverdueSeconds).toBeNull();
    // static route must not be swallowed by /api/markets/:id
    expect(queryMock.mock.calls[0][0]).toContain("resolved = false");
  });

  it("reports delayed with the overdue market ids", async () => {
    const rows = [{ id: 7, end_time: String(nowSec - 3 * 60 * 60) }];
    const queryMock = vi.fn().mockResolvedValue({ rows });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const body = (await server.inject({ method: "GET", url: "/api/markets/resolution-status" })).json();
    expect(body.status).toBe("delayed");
    expect(body.overdueMarkets).toBe(1);
    expect(body.delayedMarketIds).toEqual([7]);
    expect(body.oldestOverdueSeconds).toBeGreaterThanOrEqual(3 * 60 * 60 - 5);
  });

  it("escalates to stalled when the oldest overdue market is very old", async () => {
    const rows = [{ id: 1, end_time: String(nowSec - 20 * 60 * 60) }];
    const server = await buildTestServer({
      query: vi.fn().mockResolvedValue({ rows }) as Queryable["query"],
    });
    const body = (await server.inject({ method: "GET", url: "/api/markets/resolution-status" })).json();
    expect(body.status).toBe("stalled");
  });
});

describe("GET /api/markets/:id", () => {
  it("returns the market", async () => {
    const market = createMarket();
    const queryMock = vi.fn().mockResolvedValue({ rows: [market] });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/42"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...market,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    expect(queryMock.mock.calls[0][1]).toEqual([42]);
  });

  it("returns 404 for an unknown id", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/999"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Market not found"
      }
    });
  });

  it("returns 400 when id is not a positive integer", async () => {
    const queryMock = vi.fn();
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/0"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "id must be a positive integer"
      }
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("computeEtag", () => {
  it("is a quoted hex digest", () => {
    const etag = computeEtag({ a: 1 });
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("is stable for the same payload", () => {
    expect(computeEtag({ a: 1, b: [1, 2, 3] })).toBe(
      computeEtag({ a: 1, b: [1, 2, 3] })
    );
  });

  it("differs when the payload changes", () => {
    expect(computeEtag({ a: 1 })).not.toBe(computeEtag({ a: 2 }));
  });
});

describe("matchesIfNoneMatch", () => {
  const etag = '"abc123"';

  it("returns false when the header is absent", () => {
    expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
  });

  it("matches an exact value", () => {
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
  });

  it("matches one entry in a comma-separated list", () => {
    expect(matchesIfNoneMatch(`"other", ${etag}`, etag)).toBe(true);
  });

  it("matches the wildcard", () => {
    expect(matchesIfNoneMatch("*", etag)).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesIfNoneMatch('"other"', etag)).toBe(false);
  });
});

describe("GET /api/markets — ETag / conditional GET", () => {
  it("sets an ETag header on the list response", async () => {
    const server = await buildTestServer(createListDb([createMarket()]));

    const response = await server.inject({ method: "GET", url: "/api/markets" });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 with no body when If-None-Match matches the current ETag", async () => {
    const server = await buildTestServer(createListDb([createMarket()]));

    const first = await server.inject({ method: "GET", url: "/api/markets" });
    const etag = first.headers.etag as string;

    const second = await server.inject({
      method: "GET",
      url: "/api/markets",
      headers: { "if-none-match": etag }
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(second.headers.etag).toBe(etag);
  });

  it("returns 200 with the full body when If-None-Match is stale", async () => {
    const server = await buildTestServer(createListDb([createMarket()]));

    const response = await server.inject({
      method: "GET",
      url: "/api/markets",
      headers: { "if-none-match": '"stale-value"' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().markets).toHaveLength(1);
  });

  it("changes the ETag when the underlying data changes", async () => {
    const serverA = await buildTestServer(createListDb([createMarket({ id: 1 })]));
    const serverB = await buildTestServer(
      createListDb([createMarket({ id: 1 }), createMarket({ id: 2 })])
    );

    const responseA = await serverA.inject({ method: "GET", url: "/api/markets" });
    const responseB = await serverB.inject({ method: "GET", url: "/api/markets" });

    expect(responseA.headers.etag).not.toBe(responseB.headers.etag);
  });
});

describe("GET /api/markets - category parameter", () => {
  it("accepts valid category in TitleCase", async () => {
    const market = createMarket({ category: "Crypto" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=Crypto"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("normalizes category with leading/trailing whitespace", async () => {
    const market = createMarket({ category: "Crypto" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=%20Crypto%20"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("normalizes category from lowercase to TitleCase", async () => {
    const market = createMarket({ category: "Crypto" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=crypto"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("normalizes category from UPPERCASE to TitleCase", async () => {
    const market = createMarket({ category: "Sports" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=SPORTS"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("normalizes category with mixed case to TitleCase", async () => {
    const market = createMarket({ category: "Politics" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=pOlItIcS"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("normalizes category with both whitespace and mixed case", async () => {
    const market = createMarket({ category: "Entertainment" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=%20eNtErTaInMeNt%20"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });

  it("rejects unknown category with 400 error", async () => {
    const queryMock = vi.fn();
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=UnknownCategory"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid query parameters"
      }
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects invalid category with 400 error", async () => {
    const queryMock = vi.fn();
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets?category=invalid"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid query parameters"
      }
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts all valid categories", async () => {
    const validCategories = ["Crypto", "Sports", "Politics", "Entertainment", "Science"];
    const market = createMarket({ category: "Crypto" });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    for (const category of validCategories) {
      const response = await server.inject({
        method: "GET",
        url: `/api/markets?category=${category}`
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("works without category parameter (optional)", async () => {
    const market = createMarket();
    const queryMock = vi.fn().mockResolvedValue({ rows: [market], total: 1, page: 1, limit: 20 });
    const server = await buildTestServer({ query: queryMock as Queryable["query"] });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets"
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });
});
