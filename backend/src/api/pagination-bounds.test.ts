import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createMarketsRoutes } from "./markets.js";
import { registerLeaderboardRoutes } from "./leaderboard.js";

describe("deep pagination bounds (#477)", () => {
  it("rejects a markets page whose computed offset exceeds the cap", async () => {
    const app = Fastify({ logger: false });
    const db = { query: vi.fn() } as any;
    createMarketsRoutes(app, db);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/markets?page=102&limit=100",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("maximum 10000");
    expect(response.body).toContain("cursor-based pagination");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects a leaderboard offset above the cap", async () => {
    const app = Fastify({ logger: false });
    const pool = { query: vi.fn() } as any;
    registerLeaderboardRoutes(app, pool);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/leaderboard?offset=10001",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("10000");
    expect(response.body).toContain("cursor-based pagination");
    expect(pool.query).not.toHaveBeenCalled();
  });
});
