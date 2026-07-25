import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBetsByBettorMock, poolQueryMock } = vi.hoisted(() => ({
  getBetsByBettorMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock("../db/bets.js", () => ({
  getBetsByBettor: getBetsByBettorMock,
}));

vi.mock("../db/pool.js", () => ({
  pool: {
    query: poolQueryMock,
  },
}));

import { buildServer } from "../server.js";

describe("GET /api/v1/profile/:address", () => {
  const address = `G${"A".repeat(55)}`;

  beforeEach(() => {
    getBetsByBettorMock.mockReset();
    poolQueryMock.mockReset();
  });

  it("returns 400 for invalid Stellar addresses", async () => {
    const server = buildServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/profile/not-a-stellar-address",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Bad Request",
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

    const server = buildServer();
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

    const server = buildServer();
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
