import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { registerStatsRoutes } from "./stats";

function createPool(overrides: {
  total_markets?: string;
  total_volume?: string;
  total_users?: string;
  total_bets?: string;
} = {}): Pool {
  const row = {
    total_markets: "1",
    total_volume: "15.0000000",
    total_users: "1",
    total_bets: "1",
    ...overrides,
  };
  return {
    query: vi.fn(async () => ({ rows: [row] })),
  } as unknown as Pool;
}

async function buildTestServer(pool: Pool) {
  const server = Fastify({ logger: false });
  registerStatsRoutes(server, pool);
  await server.ready();
  return server;
}

describe("GET /api/stats — ETag / conditional GET", () => {
  it("sets an ETag header on the response", async () => {
    const server = await buildTestServer(createPool());

    const response = await server.inject({ method: "GET", url: "/api/stats" });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 with no body when If-None-Match matches the current ETag", async () => {
    const server = await buildTestServer(createPool());

    const first = await server.inject({ method: "GET", url: "/api/stats" });
    const etag = first.headers.etag as string;

    const second = await server.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "if-none-match": etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(second.headers.etag).toBe(etag);
  });

  it("returns 200 with the full body when If-None-Match is stale", async () => {
    const server = await buildTestServer(createPool());

    const response = await server.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "if-none-match": '"stale-value"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().totalMarkets).toBe(1);
  });

  it("returns 304 when If-None-Match is the wildcard", async () => {
    const server = await buildTestServer(createPool());

    const response = await server.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "if-none-match": "*" },
    });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
  });

  it("changes the ETag when the underlying data changes", async () => {
    const serverA = await buildTestServer(createPool({ total_markets: "1" }));
    const serverB = await buildTestServer(createPool({ total_markets: "2" }));

    const responseA = await serverA.inject({ method: "GET", url: "/api/stats" });
    const responseB = await serverB.inject({ method: "GET", url: "/api/stats" });

    expect(responseA.headers.etag).not.toBe(responseB.headers.etag);
  });
});
