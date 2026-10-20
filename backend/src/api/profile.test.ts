import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const { getBetsByBettorMock, getBetsByBettorPaginatedMock, poolQueryMock } = vi.hoisted(() => ({
  getBetsByBettorMock: vi.fn(),
  getBetsByBettorPaginatedMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock("../db/bets.js", () => ({
  getBetsByBettor: getBetsByBettorMock,
  getBetsByBettorPaginated: getBetsByBettorPaginatedMock,
}));

vi.mock("../db/pool.js", () => ({
  pool: {
    query: poolQueryMock,
  },
}));

import { buildServer } from "../server.js";
import { createFakePool } from "../test/fakePool.js";

describe("GET /api/v1/profile/:address", () => {
  const address = Keypair.random().publicKey();

  beforeEach(() => {
    getBetsByBettorMock.mockReset();
    getBetsByBettorPaginatedMock.mockReset();
    poolQueryMock.mockReset();
  });

  it("returns a paginated bet history for a valid address", async () => {
    const bets = [
      {
        market_id: 1,
        bettor: address,
        net_amount: "100",
        gross_amount: "120",
        is_yes: true,
        claimed: false,
        created_at: new Date("2026-07-24T10:00:00.000Z"),
      },
    ];
    getBetsByBettorPaginatedMock.mockResolvedValueOnce({
      bets,
      total: 21,
      page: 2,
      limit: 10,
      totalPages: 3,
    });

    const server = buildServer({ pool: createFakePool(poolQueryMock) });
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/profile/${address}/bets?page=2&limit=10`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(getBetsByBettorPaginatedMock).toHaveBeenCalledWith(
      expect.anything(),
      address,
      2,
      10,
    );
    expect(response.json()).toEqual({
      bets: [{ ...bets[0], created_at: bets[0].created_at.toISOString() }],
      total: 21,
      page: 2,
      limit: 10,
      totalPages: 3,
    });
    await server.close();
  });

  it("returns 400 for an invalid address on the history endpoint", async () => {
    const server = buildServer({ pool: createFakePool(poolQueryMock) });
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/profile/not-a-stellar-address/bets",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid Stellar address format",
    });
    await server.close();
  });

  it("rejects history pages beyond the maximum offset", async () => {
    const server = buildServer({ pool: createFakePool(poolQueryMock) });
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/profile/${address}/bets?page=10002&limit=1`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("maximum 10000");
    expect(getBetsByBettorPaginatedMock).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns 400 for invalid Stellar addresses", async () => {
    const server = buildServer({ pool: createFakePool(poolQueryMock) });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/profile/not-a-stellar-address",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid Stellar address format",
    });
  });

  it("returns aggregated bets and leaderboard stats for a known address", async () => {
    const bets = [
      {
        market_id: 1,
        bettor: address,
        net_amount: "100",
        gross_amount: "120",
        is_yes: true,
        claimed: false,
        created_at: new Date("2026-07-24T10:00:00.000Z"),
      },
    ];

    getBetsByBettorMock.mockResolvedValueOnce(bets);
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ points: "42", won_bets: 3, lost_bets: 1 }],
    });

    const server = buildServer({ pool: createFakePool(poolQueryMock) });
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/profile/${address}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bets: [
        {
          ...bets[0],
          created_at: bets[0].created_at.toISOString(),
        },
      ],
      points: "42",
      won_bets: 3,
      lost_bets: 1,
    });
  });

  it("returns an empty profile for an unknown address", async () => {
    getBetsByBettorMock.mockResolvedValueOnce([]);
    poolQueryMock.mockResolvedValueOnce({
      rows: [],
    });

    const server = buildServer({ pool: createFakePool(poolQueryMock) });
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/profile/${address}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bets: [],
      points: "0",
      won_bets: 0,
      lost_bets: 0,
    });
  });
});
