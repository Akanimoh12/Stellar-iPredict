import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createMarketsRoutes, parsePositiveInteger } from "./markets";
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
