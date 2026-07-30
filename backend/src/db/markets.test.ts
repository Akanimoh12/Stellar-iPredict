import { describe, expect, it, vi } from "vitest";

import { getMarketById, getMarkets, type MarketRow, type Queryable } from "./markets.js";

describe("getMarkets", () => {
  it("returns paginated markets rows and total count", async () => {
    const marketRows: MarketRow[] = [
      {
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
      },
    ];

    const queryMock = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({ rows: marketRows })
      .mockResolvedValueOnce({ rows: [{ total: 17 }] });

    const db: Queryable = {
      query: queryMock as Queryable["query"],
    };

    const result = await getMarkets(
      {
        filter: "active",
        category: "Crypto",
        sort: "volume",
        page: 2,
        limit: 10,
      },
      db,
    );

    expect(queryMock).toHaveBeenCalledTimes(2);

    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0]).toContain("FROM markets");
    expect(firstCall[0]).toContain("category = $1");
    expect(firstCall[0]).toContain("resolved = false");
    expect(firstCall[0]).toContain("ORDER BY (total_yes + total_no) DESC");
    expect(firstCall[1]).toEqual(["Crypto", 10, 10]);

    const secondCall = queryMock.mock.calls[1];
    expect(secondCall[0]).toContain("SELECT COUNT(*)::INT AS total");
    expect(secondCall[1]).toEqual(["Crypto"]);

    expect(result).toEqual({
      rows: marketRows,
      total: 17,
      page: 2,
      limit: 10,
    });
  });

  it("excludes resolved and cancelled markets when sort is ending_soon", async () => {
    const queryMock = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const db: Queryable = {
      query: queryMock as Queryable["query"],
    };

    await getMarkets({ sort: "ending_soon" }, db);

    expect(queryMock).toHaveBeenCalledTimes(2);
    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0]).toContain("resolved = false AND cancelled = false");
    expect(firstCall[0]).toContain("end_time > EXTRACT(EPOCH FROM NOW())::BIGINT");
    expect(firstCall[0]).toContain("ORDER BY end_time ASC");
  });
});

describe("getMarketById", () => {
  it("returns a market row by id", async () => {
    const market: MarketRow = {
      id: 7,
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
    };

    const queryMock = vi.fn().mockResolvedValue({ rows: [market] });
    const db: Queryable = { query: queryMock as Queryable["query"] };

    await expect(getMarketById(7, db)).resolves.toEqual(market);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("WHERE id = $1");
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
  });

  it("returns null when no market exists for the id", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const db: Queryable = { query: queryMock as Queryable["query"] };
    await expect(getMarketById(99, db)).resolves.toBeNull();
  });

  it("requires a positive integer id", async () => {
    const db: Queryable = { query: vi.fn() as Queryable["query"] };
    await expect(getMarketById(0, db)).rejects.toThrow("id must be a positive integer");
    await expect(getMarketById(1.5, db)).rejects.toThrow("id must be a positive integer");
  });
});
