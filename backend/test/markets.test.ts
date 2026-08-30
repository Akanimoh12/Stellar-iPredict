import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createMarketsRoutes } from "../src/api/markets.js";
import { registerErrorHandler, registerNotFoundHandler } from "../src/lib/errors.js";
import type { MarketRow, Queryable } from "../src/db/markets.js";

function makeMarketRow(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 1,
    question: "Will Stellar XLM reach $1 in 2026?",
    image_url: "https://example.com/image.png",
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "100.0000000",
    total_no: "50.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "G" + "A".repeat(55),
    bet_count: 5,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function buildTestServer(mockDb: Queryable): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerNotFoundHandler(server);
  createMarketsRoutes(server, mockDb);
  await server.ready();
  return server;
}

describe("Integration: GET /api/markets (Filter, Sort, Pagination)", () => {
  let mockMarkets: MarketRow[];

  beforeEach(() => {
    mockMarkets = [
      makeMarketRow({ id: 1, category: "Crypto", resolved: false, cancelled: false, end_time: "9999999999" }),
      makeMarketRow({ id: 2, category: "Sports", resolved: true, outcome: true, end_time: "1000000000" }),
      makeMarketRow({ id: 3, category: "Politics", resolved: false, cancelled: true, end_time: "1000000000" }),
      makeMarketRow({ id: 4, category: "Science", resolved: false, cancelled: false, end_time: "1000000000" }), // ended
      makeMarketRow({ id: 5, category: "Entertainment", resolved: false, cancelled: false, end_time: "9999999999" }),
    ];
  });

  // ── GET /api/markets Default List ──────────────────────────────────────────
  it("returns default paginated market list (page=1, limit=20, sort=newest, filter=all)", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) {
        return { rows: [{ total: mockMarkets.length }] };
      }
      return { rows: mockMarkets };
    });

    const server = await buildTestServer({ query: queryMock });
    const response = await server.inject({
      method: "GET",
      url: "/api/markets",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("markets");
    expect(body).toHaveProperty("total", 5);
    expect(body).toHaveProperty("page", 1);
    expect(body).toHaveProperty("limit", 20);
    expect(body.markets.length).toBe(5);
    expect(queryMock).toHaveBeenCalled();
  });

  // ── Filtering Tests ────────────────────────────────────────────────────────
  describe("Filtering by Status and Category", () => {
    it("supports filtering by status=active", async () => {
      const activeMarkets = mockMarkets.filter((m) => !m.resolved && !m.cancelled && Number(m.end_time) > Date.now() / 1000);
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        expect(sql).toContain("resolved = false AND cancelled = false AND end_time >");
        if (sql.includes("COUNT")) {
          return { rows: [{ total: activeMarkets.length }] };
        }
        return { rows: activeMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?filter=active",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.markets.length).toBe(activeMarkets.length);
    });

    it("supports filtering by status=resolved", async () => {
      const resolvedMarkets = mockMarkets.filter((m) => m.resolved);
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        expect(sql).toContain("resolved = true");
        if (sql.includes("COUNT")) {
          return { rows: [{ total: resolvedMarkets.length }] };
        }
        return { rows: resolvedMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?filter=resolved",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().markets.length).toBe(resolvedMarkets.length);
    });

    it("supports filtering by status=ended", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        expect(sql).toContain("resolved = false AND cancelled = false AND end_time <=");
        return sql.includes("COUNT") ? { rows: [{ total: 1 }] } : { rows: [mockMarkets[3]] };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?filter=ended",
      });

      expect(response.statusCode).toBe(200);
    });

    it("supports filtering by status=cancelled", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        expect(sql).toContain("cancelled = true");
        return sql.includes("COUNT") ? { rows: [{ total: 1 }] } : { rows: [mockMarkets[2]] };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?filter=cancelled",
      });

      expect(response.statusCode).toBe(200);
    });

    it("supports filtering by category=Crypto", async () => {
      const cryptoMarkets = mockMarkets.filter((m) => m.category === "Crypto");
      const queryMock = vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
        expect(sql).toContain("category = $1");
        expect(values).toContain("Crypto");
        if (sql.includes("COUNT")) {
          return { rows: [{ total: cryptoMarkets.length }] };
        }
        return { rows: cryptoMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?category=Crypto",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().markets[0].category).toBe("Crypto");
    });

    it("rejects invalid filter with 400 Bad Request", async () => {
      const queryMock = vi.fn();
      const server = await buildTestServer({ query: queryMock });

      const response = await server.inject({
        method: "GET",
        url: "/api/markets?filter=invalid_filter",
      });

      expect(response.statusCode).toBe(400);
      const code = response.json().error?.code ?? response.json().code;
      expect(["BAD_REQUEST", "FST_ERR_VALIDATION"]).toContain(code);
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("rejects invalid category with 400 Bad Request", async () => {
      const queryMock = vi.fn();
      const server = await buildTestServer({ query: queryMock });

      const response = await server.inject({
        method: "GET",
        url: "/api/markets?category=NonExistentCategory",
      });

      expect(response.statusCode).toBe(400);
      const code = response.json().error?.code ?? response.json().code;
      expect(["BAD_REQUEST", "FST_ERR_VALIDATION"]).toContain(code);
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  // ── Sorting Tests ──────────────────────────────────────────────────────────
  describe("Sorting", () => {
    it("supports sorting by newest", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        if (!sql.includes("COUNT")) {
          expect(sql).toContain("ORDER BY created_at DESC");
        }
        return sql.includes("COUNT") ? { rows: [{ total: mockMarkets.length }] } : { rows: mockMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?sort=newest",
      });

      expect(response.statusCode).toBe(200);
    });

    it("supports sorting by volume", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        if (!sql.includes("COUNT")) {
          expect(sql).toContain("ORDER BY (total_yes + total_no) DESC");
        }
        return sql.includes("COUNT") ? { rows: [{ total: mockMarkets.length }] } : { rows: mockMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?sort=volume",
      });

      expect(response.statusCode).toBe(200);
    });

    it("supports sorting by ending_soon", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        if (!sql.includes("COUNT")) {
          expect(sql).toContain("ORDER BY end_time ASC");
        }
        return sql.includes("COUNT") ? { rows: [{ total: mockMarkets.length }] } : { rows: mockMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?sort=ending_soon",
      });

      expect(response.statusCode).toBe(200);
    });

    it("supports sorting by bettors", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string) => {
        if (!sql.includes("COUNT")) {
          expect(sql).toContain("ORDER BY bet_count DESC");
        }
        return sql.includes("COUNT") ? { rows: [{ total: mockMarkets.length }] } : { rows: mockMarkets };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?sort=bettors",
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // ── Pagination Tests ───────────────────────────────────────────────────────
  describe("Pagination", () => {
    it("handles page and limit pagination parameters", async () => {
      const queryMock = vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
        if (!sql.includes("COUNT")) {
          // LIMIT $1 OFFSET $2
          expect(values).toEqual([2, 2]); // limit = 2, offset = (2-1)*2 = 2
        }
        return sql.includes("COUNT") ? { rows: [{ total: 5 }] } : { rows: [mockMarkets[2], mockMarkets[3]] };
      });

      const server = await buildTestServer({ query: queryMock });
      const response = await server.inject({
        method: "GET",
        url: "/api/markets?page=2&limit=2",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.page).toBe(2);
      expect(body.limit).toBe(2);
      expect(body.total).toBe(5);
      expect(body.markets.length).toBe(2);
    });

    it("rejects limit greater than 100 with 400 Bad Request", async () => {
      const queryMock = vi.fn();
      const server = await buildTestServer({ query: queryMock });

      const response = await server.inject({
        method: "GET",
        url: "/api/markets?limit=150",
      });

      expect(response.statusCode).toBe(400);
      const code = response.json().error?.code ?? response.json().code;
      expect(["BAD_REQUEST", "FST_ERR_VALIDATION"]).toContain(code);
      expect(queryMock).not.toHaveBeenCalled();
    });



    it("rejects negative or zero page/limit with 400 Bad Request", async () => {
      const queryMock = vi.fn();
      const server = await buildTestServer({ query: queryMock });

      const response1 = await server.inject({
        method: "GET",
        url: "/api/markets?page=0",
      });

      expect(response1.statusCode).toBe(400);

      const response2 = await server.inject({
        method: "GET",
        url: "/api/markets?limit=0",
      });

      expect(response2.statusCode).toBe(400);
      expect(queryMock).not.toHaveBeenCalled();
    });
  });
});

// ── GET /api/markets/:id & 404 Handling ─────────────────────────────────────
describe("Integration: GET /api/markets/:id and 404 handling", () => {
  it("returns market details for existing market ID", async () => {
    const market = makeMarketRow({ id: 42 });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market] });
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/42",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(42);
    expect(body.question).toBe(market.question);
    expect(queryMock.mock.calls[0][1]).toEqual([42]);
  });

  it("returns 404 NOT_FOUND for unknown market ID", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/99999",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Market not found",
      },
    });
  });

  it("returns 400 BAD_REQUEST for invalid market ID format", async () => {
    const queryMock = vi.fn();
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/not-a-number",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "id must be a positive integer",
      },
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND for undefined endpoint route", async () => {
    const queryMock = vi.fn();
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/non-existent/subpath",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── GET /api/markets/:id/odds ────────────────────────────────────────────────
describe("Integration: GET /api/markets/:id/odds", () => {
  it("returns derived odds and implied probabilities for existing market", async () => {
    const market = makeMarketRow({
      id: 10,
      total_yes: "100.0000000",
      total_no: "50.0000000",
    });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market] });
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/10/odds",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      market_id: 10,
      total_yes: "100.0000000",
      total_no: "50.0000000",
      total_pool: "150.0000000",
      yes_odds: 0.6667,
      no_odds: 0.3333,
      implied_probability: {
        yes: 0.6667,
        no: 0.3333,
      },
    });
  });

  it("handles zero-pool gracefully with 50/50 implied probability", async () => {
    const market = makeMarketRow({
      id: 11,
      total_yes: "0.0000000",
      total_no: "0.0000000",
    });
    const queryMock = vi.fn().mockResolvedValue({ rows: [market] });
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/11/odds",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      market_id: 11,
      total_yes: "0.0000000",
      total_no: "0.0000000",
      total_pool: "0.0000000",
      yes_odds: 0.5,
      no_odds: 0.5,
      implied_probability: {
        yes: 0.5,
        no: 0.5,
      },
    });
  });

  it("returns 404 for non-existent market", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/999/odds",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for invalid market ID format", async () => {
    const queryMock = vi.fn();
    const server = await buildTestServer({ query: queryMock });

    const response = await server.inject({
      method: "GET",
      url: "/api/markets/invalid-id/odds",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });
});
