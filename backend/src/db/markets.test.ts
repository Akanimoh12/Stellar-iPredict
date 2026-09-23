import { describe, expect, it, vi } from "vitest";

import { getMarketById, getMarkets, type MarketRow, type Queryable } from "./markets.js";

describe("getMarkets", () => {
  it("returns paginated markets rows and total count from a single windowed query", async () => {
    const marketRows: Array<MarketRow & { total_count: number }> = [
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
        total_count: 17,
      },
    ];

    const queryMock = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({ rows: marketRows });

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

    // A single round trip: no separate COUNT(*) query is issued.
    expect(queryMock).toHaveBeenCalledTimes(1);

    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0]).toContain("FROM markets");
    expect(firstCall[0]).toContain("category = $1");
    expect(firstCall[0]).toContain("resolved = false");
    expect(firstCall[0]).toContain("ORDER BY (total_yes + total_no) DESC");
    expect(firstCall[0]).toContain("COUNT(*) OVER ()");
    expect(firstCall[1]).toEqual(["Crypto", 10, 10]);

    const { total_count: _omit, ...expectedRow } = marketRows[0];
    expect(result).toEqual({
      rows: [expectedRow],
      total: 17,
      page: 2,
      limit: 10,
    });
  });

  it("excludes resolved and cancelled markets when sort is ending_soon", async () => {
    const queryMock = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({ rows: [] });

    const db: Queryable = {
      query: queryMock as Queryable["query"],
    };

    const result = await getMarkets({ sort: "ending_soon" }, db);

    // Empty page falls back to a single plain COUNT(*) query.
    expect(queryMock).toHaveBeenCalledTimes(2);
    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0]).toContain("resolved = false AND cancelled = false");
    expect(firstCall[0]).toContain("end_time > EXTRACT(EPOCH FROM NOW())::BIGINT");
    expect(firstCall[0]).toContain("ORDER BY end_time ASC");
    expect(result.total).toBe(0);
  });

  it("computes the total count over the filtered set, not the whole table", async () => {
    const rowFor = (id: number, total: number) => ({
      id,
      question: "q",
      image_url: null,
      category: "Crypto" as const,
      end_time: "1",
      total_yes: "0",
      total_no: "0",
      resolved: false,
      outcome: null,
      cancelled: false,
      creator: "G",
      bet_count: 0,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
      total_count: total,
    });

    const queryMock = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({ rows: [rowFor(1, 3)] });
    const db: Queryable = { query: queryMock as Queryable["query"] };

    const result = await getMarkets({ filter: "resolved" }, db);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("resolved = true");
    expect(result.total).toBe(3);
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

  it("preserves exact string amounts larger than Number.MAX_SAFE_INTEGER without precision loss", async () => {
    const hugeAmountStr = "12345678901234567890.1234567";
    const market: MarketRow = {
      id: 8,
      question: "Large amount market",
      image_url: null,
      category: "Crypto",
      end_time: "1735689600",
      total_yes: hugeAmountStr,
      total_no: hugeAmountStr,
      resolved: false,
      outcome: null,
      cancelled: false,
      creator: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      bet_count: 1,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    };

    const queryMock = vi.fn().mockResolvedValue({ rows: [market] });
    const db: Queryable = { query: queryMock as Queryable["query"] };

    const result = await getMarketById(8, db);
    expect(result?.total_yes).toBe(hugeAmountStr);
    expect(result?.total_no).toBe(hugeAmountStr);
    expect(typeof result?.total_yes).toBe("string");
    expect(typeof result?.total_no).toBe("string");
  });
});

