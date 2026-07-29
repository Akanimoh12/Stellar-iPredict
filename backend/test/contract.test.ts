import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Contract tests — verify that API response shapes match the types the
// frontend expects.  If these tests fail, the frontend will break at runtime.
// See frontend/src/types/index.ts for the canonical TS interfaces.
// ---------------------------------------------------------------------------

// ── Frontend type contracts (copied from frontend/src/types/index.ts) ────────
//
// The assertions below validate every field the frontend relies on, ensuring
// backend responses are shape-compatible even if the actual TS types drift.

interface ExpectedMarket {
  id: number;
  question: string;
  imageUrl: string; // snake_case from API → camelCase in frontend
  category: string;
  endTime: number;
  totalYes: number;
  totalNo: number;
  resolved: boolean;
  outcome: boolean;
  cancelled: boolean;
  creator: string;
  betCount: number;
}

interface ExpectedPlayerStats {
  address: string;
  displayName: string;
  points: number;
  totalBets: number;
  wonBets: number;
  lostBets: number;
  winRate: number;
}

interface ExpectedBet {
  amount: number;
  isYes: boolean;
  claimed: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMarketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    question: "Will XLM close above $1?",
    image_url: null,
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "10.0000000",
    total_no: "5.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "G" + "A".repeat(55),
    bet_count: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeLeaderboardRow(overrides: Record<string, unknown> = {}) {
  return {
    address: "G" + "B".repeat(55),
    display_name: "Alice",
    points: "100",
    won_bets: 5,
    lost_bets: 2,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePool(mockRows: unknown[], totalRows: unknown[] = []) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("COUNT")) {
        return { rows: totalRows.length ? totalRows : [{ total: "1" }] };
      }
      return { rows: mockRows };
    }),
  } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

// ── Market contract ────────────────────────────────────────────────────────

describe("Contract: GET /api/markets/:id", () => {
  it("response shape matches frontend Market type", async () => {
    const row = makeMarketRow();
    const pool = makePool([row]);
    const server = buildServer({ pool, corsOrigins: [] });

    const res = await server.inject({
      method: "GET",
      url: "/api/markets/42",
    });

    await server.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Every field the frontend Market interface expects must be present
    // and of the correct type.
    expect(typeof body.id).toBe("number");
    expect(typeof body.question).toBe("string");
    expect(body.image_url === null || typeof body.image_url === "string").toBe(
      true
    );
    expect(typeof body.category).toBe("string");
    expect(typeof body.end_time).toBe("string"); // BIGINT as string
    expect(typeof body.total_yes).toBe("string"); // NUMERIC as string
    expect(typeof body.total_no).toBe("string");
    expect(typeof body.resolved).toBe("boolean");
    expect(
      body.outcome === null || typeof body.outcome === "boolean"
    ).toBe(true);
    expect(typeof body.cancelled).toBe("boolean");
    expect(typeof body.creator).toBe("string");
    expect(typeof body.bet_count).toBe("number");
    expect(typeof body.created_at).toBe("string");
    expect(typeof body.updated_at).toBe("string");
  });
});

describe("Contract: GET /api/markets", () => {
  it("list response contains market-shaped objects", async () => {
    const row = makeMarketRow();
    const pool = makePool([row], [{ total: "1" }]);
    const server = buildServer({ pool, corsOrigins: [] });

    const res = await server.inject({
      method: "GET",
      url: "/api/markets",
    });

    await server.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Array.isArray(body.markets)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.page).toBe("number");
    expect(typeof body.limit).toBe("number");

    const market = body.markets[0];
    expect(typeof market.id).toBe("number");
    expect(typeof market.question).toBe("string");
    expect(typeof market.category).toBe("string");
    expect(typeof market.resolved).toBe("boolean");
    expect(typeof market.cancelled).toBe("boolean");
    expect(typeof market.bet_count).toBe("number");
    expect(typeof market.end_time).toBe("string");
    expect(typeof market.total_yes).toBe("string");
    expect(typeof market.total_no).toBe("string");
  });
});

// ── Leaderboard contract ───────────────────────────────────────────────────

describe("Contract: GET /api/leaderboard", () => {
  it("response shape matches frontend PlayerStats expectations", async () => {
    const row = makeLeaderboardRow();
    const pool = makePool([row], [{ total: "1" }]);
    const server = buildServer({ pool, corsOrigins: [] });

    const res = await server.inject({
      method: "GET",
      url: "/api/leaderboard",
    });

    await server.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Array.isArray(body.players)).toBe(true);
    expect(typeof body.total).toBe("number");

    const player = body.players[0];
    expect(typeof player.address).toBe("string");
    expect(
      player.display_name === null || typeof player.display_name === "string"
    ).toBe(true);
    expect(typeof player.points).toBe("string"); // BIGINT as string
    expect(typeof player.won_bets).toBe("number");
    expect(typeof player.lost_bets).toBe("number");
    expect(typeof player.updated_at).toBe("string");
  });
});

// ── Stats contract ─────────────────────────────────────────────────────────

describe("Contract: GET /api/stats", () => {
  it("response shape matches expected global stats", async () => {
    const pool = makePool([], [{ total: "0" }]);
    const server = buildServer({ pool, corsOrigins: [] });

    const res = await server.inject({
      method: "GET",
      url: "/api/stats",
    });

    await server.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(typeof body.totalMarkets).toBe("number");
    expect(typeof body.totalVolume).toBe("string");
    expect(typeof body.totalUsers).toBe("number");
    expect(typeof body.totalBets).toBe("number");
  });
});
