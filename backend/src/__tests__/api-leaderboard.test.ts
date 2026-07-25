import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildServer } from "../server.js";

function makePool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("COUNT")) {
        return { rows: [{ total: "2" }] };
      }

      return {
        rows: [
          {
            address: "GALICE",
            display_name: "Alice",
            points: "100",
            won_bets: 3,
            lost_bets: 1,
            updated_at: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      };
    }),
  } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

describe("GET /api/leaderboard", () => {
  it("returns paginated leaderboard players with total", async () => {
    const pool = makePool();
    const server = buildServer({ pool });

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?offset=5&limit=10&sort=bets",
    });

    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      players: [
        {
          address: "GALICE",
          display_name: "Alice",
          points: "100",
          won_bets: 3,
          lost_bets: 1,
        },
      ],
      total: 2,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY (won_bets + lost_bets) DESC"),
      [10, 5]
    );
  });

  it("rejects invalid pagination and sort parameters", async () => {
    const server = buildServer({ pool: makePool() });

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard?offset=-1&limit=101&sort=name",
    });

    await server.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid leaderboard query parameters",
    });
  });
});
