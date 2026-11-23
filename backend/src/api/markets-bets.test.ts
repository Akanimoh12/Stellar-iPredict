/**
 * Tests for GET /api/markets/:id/bets  (#113)
 *
 * Verifies:
 * - Route returns paginated bets from the DB.
 * - 30s TTL cache via Redis (getOrSet) is exercised when a Redis client is passed.
 * - Cache hit avoids a second DB call.
 * - Missing market returns 404.
 * - Bad id returns 400.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createMarketsRoutes } from "./markets.js";
import { registerErrorHandler } from "../lib/errors.js";
import type { Queryable } from "../db/markets.js";
import type { BetRow } from "../db/bets.js";
import type { MarketRow } from "../db/markets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: 1,
    question: "Will XLM close above $1?",
    image_url: null,
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "10.0000000",
    total_no: "5.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    bet_count: 2,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createBet(overrides: Partial<BetRow> = {}): BetRow {
  return {
    market_id: "1",
    bettor: "GAAAA",
    net_amount: "5.0000000",
    gross_amount: "5.0000000",
    is_yes: true,
    claimed: false,
    created_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Build a mock Queryable that returns `market` for market queries and
 * `bets` / `total` for bet queries.
 */
function createDb(market: MarketRow | null, bets: BetRow[], total = bets.length): Queryable {
  return {
    query: vi.fn(async (sql: string) => {
      // Market lookup
      if (sql.includes("FROM markets") && !sql.includes("COUNT")) {
        return { rows: market ? [market] : [] };
      }
      // Bet count
      if (sql.includes("COUNT") && sql.includes("bets")) {
        return { rows: [{ total }] };
      }
      // Bet rows
      if (sql.includes("FROM bets")) {
        return { rows: bets };
      }
      return { rows: [] };
    }) as Queryable["query"],
  };
}

async function buildServer(db: Queryable) {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  createMarketsRoutes(server, db);
  await server.ready();
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/markets/:id/bets", () => {
  it("returns 400 for a non-integer id", async () => {
    const server = await buildServer(createDb(createMarket(), []));
    const res = await server.inject({ method: "GET", url: "/api/markets/abc/bets" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for id = 0", async () => {
    const server = await buildServer(createDb(createMarket(), []));
    const res = await server.inject({ method: "GET", url: "/api/markets/0/bets" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the market does not exist", async () => {
    const server = await buildServer(createDb(null, []));
    const res = await server.inject({ method: "GET", url: "/api/markets/99/bets" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 200 with an empty bets array when no bets exist", async () => {
    const server = await buildServer(createDb(createMarket(), []));
    const res = await server.inject({ method: "GET", url: "/api/markets/1/bets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bets).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
    expect(body.totalPages).toBe(0);
  });

  it("returns bets with correct shape", async () => {
    const bet = createBet();
    const server = await buildServer(createDb(createMarket(), [bet]));
    const res = await server.inject({ method: "GET", url: "/api/markets/1/bets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bets).toHaveLength(1);
    const returned = body.bets[0];
    expect(returned.market_id).toBe("1");
    expect(returned.bettor).toBe("GAAAA");
    expect(returned.is_yes).toBe(true);
  });

  it("respects page and limit query params", async () => {
    const bets = [createBet({ bettor: "GA" }), createBet({ bettor: "GB" })];
    const server = await buildServer(createDb(createMarket(), bets, 10));
    const res = await server.inject({
      method: "GET",
      url: "/api/markets/1/bets?page=1&limit=2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.limit).toBe(2);
    expect(body.page).toBe(1);
  });

  it("uses Redis cache on second request (only one DB load)", async () => {
    const bet = createBet();
    const db = createDb(createMarket(), [bet]);

    // Minimal in-memory Redis mock
    const store = new Map<string, string>();
    const redisMock = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
      }),
    };

    const server = Fastify({ logger: false });
    registerErrorHandler(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMarketsRoutes(server, db, redisMock as any);
    await server.ready();

    // First request — cache miss, DB is called.
    const res1 = await server.inject({ method: "GET", url: "/api/markets/1/bets" });
    expect(res1.statusCode).toBe(200);

    // Second request — cache hit, DB should NOT be called again for bets.
    const callsBefore = (db.query as ReturnType<typeof vi.fn>).mock.calls.length;
    const res2 = await server.inject({ method: "GET", url: "/api/markets/1/bets" });
    expect(res2.statusCode).toBe(200);

    // setex should have been called once (on first miss) for bets.
    expect(redisMock.setex).toHaveBeenCalled();
    // The DB should not have been called extra times for bets on second request.
    const callsAfter = (db.query as ReturnType<typeof vi.fn>).mock.calls.length;
    // Only market lookup may repeat (it has its own cache key).
    // Bets DB queries should not have doubled.
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(1); // at most market re-check
  });
});
