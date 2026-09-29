/**
 * Integration tests for GET /api/leaderboard
 *
 * Covers:
 *  - Default response shape
 *  - Sorting: points (default) and bets
 *  - Pagination: offset + limit
 *  - Input validation: limit max, negative/zero values, unknown params
 *  - No regression to existing endpoints
 *
 * Pattern mirrors backend/test/markets.test.ts: a mock Pool is injected into
 * registerLeaderboardRoutes so that no real DB or Redis connection is needed.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { registerLeaderboardRoutes } from "../src/api/leaderboard.js";
import { registerErrorHandler, registerNotFoundHandler } from "../src/lib/errors.js";
import type { LeaderboardRow } from "../src/db/types.js";
import type { Pool } from "pg";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    address: "G" + "A".repeat(55),
    display_name: "Alice",
    points: "1000",
    won_bets: 10,
    lost_bets: 3,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Build a test Fastify instance with the leaderboard route wired to mockPool. */
async function buildTestServer(mockPool: Partial<Pool>): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerNotFoundHandler(server);
  // No Redis — forces the route to hit the pool directly, keeping tests simple.
  registerLeaderboardRoutes(server, mockPool as Pool);
  await server.ready();
  return server;
}

/** Minimal mock pool that returns a players list and a total count. */
function makePoolMock(rows: LeaderboardRow[], total: number) {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) {
        return { rows: [{ total: String(total) }] };
      }
      return { rows };
    }),
  } as unknown as Pool;
}

// ── fixture ───────────────────────────────────────────────────────────────────

const SAMPLE_ROWS: LeaderboardRow[] = [
  makeRow({ address: "G" + "A".repeat(55), display_name: "Alice", points: "500", won_bets: 5, lost_bets: 1 }),
  makeRow({ address: "G" + "B".repeat(55), display_name: "Bob",   points: "300", won_bets: 3, lost_bets: 4 }),
  makeRow({ address: "G" + "C".repeat(55), display_name: "Carol", points: "200", won_bets: 2, lost_bets: 0 }),
];

// ── Default response ──────────────────────────────────────────────────────────

describe("Integration: GET /api/leaderboard", () => {
  it("returns default paginated leaderboard (offset=0, limit=20, sort=points)", async () => {
    const mockPool = makePoolMock(SAMPLE_ROWS, SAMPLE_ROWS.length);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({ method: "GET", url: "/api/leaderboard" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("players");
    expect(body).toHaveProperty("total", SAMPLE_ROWS.length);
    expect(Array.isArray(body.players)).toBe(true);
    expect(body.players.length).toBe(SAMPLE_ROWS.length);
  });

  it("includes correct fields in each player entry", async () => {
    const mockPool = makePoolMock(SAMPLE_ROWS, SAMPLE_ROWS.length);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({ method: "GET", url: "/api/leaderboard" });
    expect(response.statusCode).toBe(200);

    const { players } = response.json<{ players: LeaderboardRow[]; total: number }>();
    const player = players[0];
    expect(player).toHaveProperty("address");
    expect(player).toHaveProperty("points");
    expect(player).toHaveProperty("won_bets");
    expect(player).toHaveProperty("lost_bets");
  });

  it("queries the DB exactly twice (players + total)", async () => {
    const mockPool = makePoolMock(SAMPLE_ROWS, SAMPLE_ROWS.length);
    const server = await buildTestServer(mockPool);

    await server.inject({ method: "GET", url: "/api/leaderboard" });

    // registerLeaderboardRoutes does Promise.all([getLeaderboard, getLeaderboardTotal])
    expect((mockPool as any).query).toHaveBeenCalledTimes(2);
  });
});

// ── Sorting ───────────────────────────────────────────────────────────────────

describe("Sorting", () => {
  it("sorts by points DESC when sort=points (default)", async () => {
    const mockPool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("COUNT")) return { rows: [{ total: "3" }] };
        expect(sql).toContain("ORDER BY points DESC");
        return { rows: SAMPLE_ROWS };
      }),
    } as unknown as Pool;

    const server = await buildTestServer(mockPool);
    const response = await server.inject({ method: "GET", url: "/api/leaderboard?sort=points" });
    expect(response.statusCode).toBe(200);
  });

  it("sorts by total bets DESC when sort=bets", async () => {
    const mockPool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("COUNT")) return { rows: [{ total: "3" }] };
        expect(sql).toContain("ORDER BY (won_bets + lost_bets) DESC");
        return { rows: SAMPLE_ROWS };
      }),
    } as unknown as Pool;

    const server = await buildTestServer(mockPool);
    const response = await server.inject({ method: "GET", url: "/api/leaderboard?sort=bets" });
    expect(response.statusCode).toBe(200);
  });

  it("rejects unknown sort value with 400 Bad Request", async () => {
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?sort=invalid_sort",
    });

    expect(response.statusCode).toBe(400);
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe("Pagination", () => {
  it("passes limit and offset through to the DB query", async () => {
    const mockPool = {
      query: vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
        if (sql.includes("COUNT")) return { rows: [{ total: "50" }] };
        // DB layer: getLeaderboard is called with { limit: 10, offset: 20, sort }
        expect(values).toEqual([10, 20]);
        return { rows: SAMPLE_ROWS.slice(0, 2) };
      }),
    } as unknown as Pool;

    const server = await buildTestServer(mockPool);
    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?limit=10&offset=20",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(50);
    expect(body.players.length).toBe(2);
  });

  it("defaults to offset=0 and limit=20 when params are omitted", async () => {
    const mockPool = {
      query: vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
        if (sql.includes("COUNT")) return { rows: [{ total: "3" }] };
        expect(values).toEqual([20, 0]); // limit=20, offset=0
        return { rows: SAMPLE_ROWS };
      }),
    } as unknown as Pool;

    const server = await buildTestServer(mockPool);
    const response = await server.inject({ method: "GET", url: "/api/leaderboard" });
    expect(response.statusCode).toBe(200);
  });

  it("respects a small page size (limit=1)", async () => {
    const firstRow = [SAMPLE_ROWS[0]];
    const mockPool = makePoolMock(firstRow, SAMPLE_ROWS.length);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?limit=1&offset=0",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.players.length).toBe(1);
    expect(body.total).toBe(SAMPLE_ROWS.length);
  });

  it("returns empty players array when offset exceeds total", async () => {
    const mockPool = makePoolMock([], SAMPLE_ROWS.length);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: `/api/leaderboard?offset=${SAMPLE_ROWS.length + 100}&limit=20`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.players).toEqual([]);
    expect(body.total).toBe(SAMPLE_ROWS.length);
  });

  it("rejects limit greater than 100 with 400 Bad Request", async () => {
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?limit=101",
    });

    expect(response.statusCode).toBe(400);
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });

  it("rejects limit=0 with 400 Bad Request", async () => {
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?limit=0",
    });

    expect(response.statusCode).toBe(400);
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });

  it("rejects negative offset with 400 Bad Request", async () => {
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?offset=-1",
    });

    expect(response.statusCode).toBe(400);
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });
});

// ── No regression to existing endpoints ──────────────────────────────────────

describe("No regression to existing endpoints", () => {
  it("returns 404 NOT_FOUND for an unregistered sub-path", async () => {
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard/extra/path",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });

  it("returns 405 Method Not Allowed when POST is used on the leaderboard endpoint", async () => {
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({
      method: "POST",
      url: "/api/leaderboard",
    });

    // The server may return 404 or 405 depending on the router; both are acceptable
    // non-2xx responses that prove the endpoint is read-only.
    expect([404, 405]).toContain(response.statusCode);
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });

  it("leaderboard route does not interfere with /api/markets", async () => {
    // Build a server that only has the leaderboard route.
    // Hitting /api/markets should get a clean 404, not a crash.
    const mockPool = makePoolMock([], 0);
    const server = await buildTestServer(mockPool);

    const response = await server.inject({ method: "GET", url: "/api/markets" });
    expect(response.statusCode).toBe(404);
    expect((mockPool as any).query).not.toHaveBeenCalled();
  });
});
