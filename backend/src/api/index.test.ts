import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { getBetsByBettorMock, poolQueryMock } = vi.hoisted(() => ({
  getBetsByBettorMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock("../db/bets.js", () => ({ getBetsByBettor: getBetsByBettorMock }));
vi.mock("../db/pool.js", () => ({ pool: { query: poolQueryMock } }));

import { buildServer } from "../server.js";
import { API_PREFIX, API_VERSION, routers } from "./index.js";

const ADDRESS = `G${"A".repeat(55)}`;

let server: FastifyInstance | undefined;

function makeServer(): FastifyInstance {
  server = buildServer({ corsOrigins: [] });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  getBetsByBettorMock.mockReset();
  poolQueryMock.mockReset();
});

describe("route index", () => {
  it("versions the prefix", () => {
    expect(API_VERSION).toBe("v1");
    expect(API_PREFIX).toBe("/api/v1");
  });

  it("registers at least one feature router", () => {
    expect(routers.length).toBeGreaterThan(0);
  });
});

describe("mounting", () => {
  it("serves feature routes under /api/v1", async () => {
    getBetsByBettorMock.mockResolvedValueOnce([]);
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bets: [] });
  });

  it("reaches the route's own validation, not a router miss", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/not-a-stellar-address`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Invalid Stellar address format");
  });

  it("does not serve feature routes off the unversioned prefix", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `/api/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(404);
    expect(getBetsByBettorMock).not.toHaveBeenCalled();
  });

  it("leaves the unversioned health probe alone", async () => {
    const res = await makeServer().inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
