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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

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

// ── SQL generation, ORDER BY clauses, and WHERE predicates ──────────────────

function makeCapture(): { db: Queryable; calls: string[] } {
  const calls: string[] = [];
  const db: Queryable = {
    query: vi.fn(async (text: string) => {
      calls.push(text);
      return { rows: [] };
    }),
  };
  return { db, calls };
}

function extractOrderBy(sql: string): string {
  const match = sql.match(/ORDER BY\s+(.+?)\s+LIMIT/si);
  if (!match) throw new Error(`No ORDER BY found in:\n${sql}`);
  return match[1].replace(/\s+/g, " ").trim();
}

function extractWhere(sql: string): string {
  const match = sql.match(/WHERE\s+(.+?)\s+ORDER BY/si);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim();
}

describe("getMarkets ORDER BY clause", () => {
  it("newest → ORDER BY created_at DESC, id ASC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "newest", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("created_at DESC, id ASC");
  });

  it("volume → ORDER BY (total_yes + total_no) DESC, created_at DESC, id ASC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "volume", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe(
      "(total_yes + total_no) DESC, created_at DESC, id ASC"
    );
  });

  it("ending_soon → ORDER BY end_time ASC, id ASC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "ending_soon", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("end_time ASC, id ASC");
  });

  it("bettors → ORDER BY bet_count DESC, created_at DESC, id ASC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "bettors", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("bet_count DESC, created_at DESC, id ASC");
  });
});

describe("getMarkets WHERE predicates", () => {
  it("filter=all produces no WHERE clause", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "all", sort: "newest" }, db);
    expect(calls[0]).not.toMatch(/\bWHERE\b/i);
  });

  it("filter=active produces resolved=false AND cancelled=false AND end_time > now() predicate", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "active", sort: "newest" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("resolved = false");
    expect(where).toContain("cancelled = false");
    expect(where).toContain("end_time >");
  });

  it("filter=resolved produces resolved=true predicate", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "resolved", sort: "newest" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("resolved = true");
  });

  it("filter=cancelled produces cancelled=true predicate", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "cancelled", sort: "newest" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("cancelled = true");
  });

  it("filter=ended produces resolved=false AND cancelled=false AND end_time <= now() predicate", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "ended", sort: "newest" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("resolved = false");
    expect(where).toContain("cancelled = false");
    expect(where).toContain("end_time <=");
  });

  it("sort=ending_soon always appends active-only predicate even with filter=all", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "all", sort: "ending_soon" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("resolved = false");
    expect(where).toContain("cancelled = false");
    expect(where).toContain("end_time >");
  });
});

describe("getMarkets category filter", () => {
  it("category adds a category = $1 predicate and uses $1 as the first bind value", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "all", sort: "newest", category: "Crypto" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("category = $1");
  });

  it("category combined with filter=active: category clause comes first in WHERE", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "active", sort: "newest", category: "Sports" }, db);
    const where = extractWhere(calls[0]);
    expect(where).toContain("category = $1");
    expect(where).toContain("resolved = false");
  });
});

describe("ORDER BY expressions match migration 0028 index definitions with id tiebreaker", () => {
  it("newest ORDER BY matches idx_markets_created_at definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "newest", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("created_at DESC, id ASC");
  });

  it("volume ORDER BY matches idx_markets_volume_tiebreak definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "volume", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe(
      "(total_yes + total_no) DESC, created_at DESC, id ASC"
    );
  });

  it("bettors ORDER BY matches idx_markets_bettors definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "bettors", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("bet_count DESC, created_at DESC, id ASC");
  });

  it("ending_soon ORDER BY matches idx_markets_active_partial definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "ending_soon", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("end_time ASC, id ASC");
  });
});

describe("getMarkets pagination bind parameters", () => {
  it("LIMIT and OFFSET appear at the end of bind values for filter=all/no-category", async () => {
    const { db } = makeCapture();
    const querySpy = vi.spyOn(db, "query");
    await getMarkets({ filter: "all", sort: "newest", page: 2, limit: 10 }, db);
    const [, values] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([10, 10]);
  });

  it("LIMIT and OFFSET shift by one when category is present", async () => {
    const { db } = makeCapture();
    const querySpy = vi.spyOn(db, "query");
    await getMarkets(
      { filter: "all", sort: "newest", page: 1, limit: 5, category: "Crypto" },
      db
    );
    const [, values] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual(["Crypto", 5, 0]);
  });
});

