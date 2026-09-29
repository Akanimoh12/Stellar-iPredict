import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { registerLeaderboardRoutes } from "./leaderboard";
import type { LeaderboardRow } from "../db/leaderboard.js";

function createRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    address: "G1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    display_name: "Alice",
    points: "100",
    won_bets: 2,
    lost_bets: 0,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createPool(rows: LeaderboardRow[]): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ total: String(rows.length) }] };
      }
      return { rows };
    }),
  } as unknown as Pool;
}

async function buildTestServer(pool: Pool) {
  const server = Fastify({ logger: false });
  registerLeaderboardRoutes(server, pool);
  await server.ready();
  return server;
}

describe("GET /api/leaderboard — ETag / conditional GET", () => {
  it("sets an ETag header on the response", async () => {
    const server = await buildTestServer(createPool([createRow()]));

    const response = await server.inject({ method: "GET", url: "/api/leaderboard" });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 with no body when If-None-Match matches the current ETag", async () => {
    const server = await buildTestServer(createPool([createRow()]));

    const first = await server.inject({ method: "GET", url: "/api/leaderboard" });
    const etag = first.headers.etag as string;

    const second = await server.inject({
      method: "GET",
      url: "/api/leaderboard",
      headers: { "if-none-match": etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(second.headers.etag).toBe(etag);
  });

  it("returns 200 with the full body when If-None-Match is stale", async () => {
    const server = await buildTestServer(createPool([createRow()]));

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard",
      headers: { "if-none-match": '"stale-value"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().players).toHaveLength(1);
  });

  it("returns 200 with the full body when If-None-Match is the wildcard on a stale server", async () => {
    // Wildcard matches any current representation, so this should 304 too.
    const server = await buildTestServer(createPool([createRow()]));

    const response = await server.inject({
      method: "GET",
      url: "/api/leaderboard",
      headers: { "if-none-match": "*" },
    });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
  });

  it("changes the ETag when the underlying data changes", async () => {
    const serverA = await buildTestServer(createPool([createRow({ address: "G1" })]));
    const serverB = await buildTestServer(
      createPool([createRow({ address: "G1" }), createRow({ address: "G2" })])
    );

    const responseA = await serverA.inject({ method: "GET", url: "/api/leaderboard" });
    const responseB = await serverB.inject({ method: "GET", url: "/api/leaderboard" });

    expect(responseA.headers.etag).not.toBe(responseB.headers.etag);
  });
});
