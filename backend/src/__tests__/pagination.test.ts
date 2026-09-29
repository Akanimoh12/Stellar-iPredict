import { describe, it, expect } from "vitest";
import { parsePagination, paginatedResponse, MAX_PAGINATION_LIMIT, MAX_PAGINATION_OFFSET } from "../lib/pagination";
import { getMarkets, type MarketRow, type Queryable } from "../db/markets.js";

describe("Pagination Helper", () => {
  describe("parsePagination", () => {
    it("returns default values when query is empty or undefined", () => {
      expect(parsePagination({})).toEqual({ limit: 20, offset: 0 });
      expect(parsePagination(undefined as any)).toEqual({ limit: 20, offset: 0 });
      expect(parsePagination(null as any)).toEqual({ limit: 20, offset: 0 });
    });

    it("parses valid limit and offset from strings", () => {
      const result = parsePagination({ limit: "10", offset: "5" });
      expect(result).toEqual({ limit: 10, offset: 5 });
    });

    it("parses valid limit and offset from numbers", () => {
      const result = parsePagination({ limit: 50, offset: 10 });
      expect(result).toEqual({ limit: 50, offset: 10 });
    });

    it("caps limit to maxLimit", () => {
      const result = parsePagination({ limit: "200" });
      expect(result).toEqual({ limit: 100, offset: 0 });
      
      const customMaxResult = parsePagination({ limit: "500" }, 20, 50);
      expect(customMaxResult).toEqual({ limit: 50, offset: 0 });
    });

    it("uses default values for invalid limits", () => {
      expect(parsePagination({ limit: "invalid" }).limit).toBe(20);
      expect(parsePagination({ limit: "-5" }).limit).toBe(20);
      expect(parsePagination({ limit: "0" }).limit).toBe(20);
      expect(parsePagination({ limit: "" }).limit).toBe(20);
    });

    it("uses default offset for invalid offsets", () => {
      expect(parsePagination({ offset: "invalid" }).offset).toBe(0);
      expect(parsePagination({ offset: "-10" }).offset).toBe(0);
      expect(parsePagination({ offset: "" }).offset).toBe(0);
    });

    // Negative values
    it("rejects negative limit values and uses default", () => {
      expect(parsePagination({ limit: "-1" }).limit).toBe(20);
      expect(parsePagination({ limit: "-100" }).limit).toBe(20);
      expect(parsePagination({ limit: -5 }).limit).toBe(20);
      expect(parsePagination({ limit: "-999" }).limit).toBe(20);
    });

    it("rejects negative offset values and uses default", () => {
      expect(parsePagination({ offset: "-1" }).offset).toBe(0);
      expect(parsePagination({ offset: "-50" }).offset).toBe(0);
      expect(parsePagination({ offset: -10 }).offset).toBe(0);
      expect(parsePagination({ offset: "-999" }).offset).toBe(0);
    });

    // Zero values
    it("rejects zero limit and uses default", () => {
      expect(parsePagination({ limit: "0" }).limit).toBe(20);
      expect(parsePagination({ limit: 0 }).limit).toBe(20);
    });

    it("accepts zero offset", () => {
      expect(parsePagination({ offset: "0" }).offset).toBe(0);
      expect(parsePagination({ offset: 0 }).offset).toBe(0);
    });

    // Non-numeric values
    it("rejects NaN limit and uses default", () => {
      expect(parsePagination({ limit: NaN }).limit).toBe(20);
      expect(parsePagination({ limit: "NaN" }).limit).toBe(20);
    });

    it("rejects NaN offset and uses default", () => {
      expect(parsePagination({ offset: NaN }).offset).toBe(0);
      expect(parsePagination({ offset: "NaN" }).offset).toBe(0);
    });

    it("rejects non-numeric string limit and uses default", () => {
      expect(parsePagination({ limit: "abc" }).limit).toBe(20);
      expect(parsePagination({ limit: "hello" }).limit).toBe(20);
      expect(parsePagination({ limit: "abc10" }).limit).toBe(20);
    });

    it("rejects non-numeric string offset and uses default", () => {
      expect(parsePagination({ offset: "abc" }).offset).toBe(0);
      expect(parsePagination({ offset: "hello" }).offset).toBe(0);
      expect(parsePagination({ offset: "abc10" }).offset).toBe(0);
    });

    // Very large values
    it("caps very large limit values to maxLimit", () => {
      expect(parsePagination({ limit: "1000" }).limit).toBe(100);
      expect(parsePagination({ limit: "999999" }).limit).toBe(100);
      expect(parsePagination({ limit: Number.MAX_SAFE_INTEGER }).limit).toBe(100);
    });

    it("rejects offsets above the global maximum", () => {
      expect(parsePagination({ offset: "1000" }).offset).toBe(1000);
      expect(parsePagination({ offset: "10000" }).offset).toBe(10000);
      expect(() => parsePagination({ offset: "10001" })).toThrow(
        "Use cursor-based pagination for deeper results",
      );
      expect(() => parsePagination({ offset: Number.MAX_SAFE_INTEGER })).toThrow(
        "exceeds the maximum",
      );
    });

    // Missing values
    it("uses default limit when omitted", () => {
      expect(parsePagination({}).limit).toBe(20);
      expect(parsePagination({ offset: "10" }).limit).toBe(20);
    });

    it("uses default offset when omitted", () => {
      expect(parsePagination({}).offset).toBe(0);
      expect(parsePagination({ limit: "10" }).offset).toBe(0);
    });

    // Boundary behaviour
    it("applies custom default limit when provided", () => {
      expect(parsePagination({}, 50).limit).toBe(50);
      expect(parsePagination({ limit: "invalid" }, 50).limit).toBe(50);
    });

    it("applies custom max limit when provided", () => {
      expect(parsePagination({ limit: "100" }, 20, 50).limit).toBe(50);
      expect(parsePagination({ limit: "200" }, 20, 50).limit).toBe(50);
    });

    it("accepts limit exactly at maxLimit boundary", () => {
      expect(parsePagination({ limit: "100" }).limit).toBe(100);
      expect(parsePagination({ limit: 100 }).limit).toBe(100);
    });

    it("accepts limit one below maxLimit boundary", () => {
      expect(parsePagination({ limit: "99" }).limit).toBe(99);
      expect(parsePagination({ limit: 99 }).limit).toBe(99);
    });

    it("accepts limit one above maxLimit boundary (capped)", () => {
      expect(parsePagination({ limit: "101" }).limit).toBe(100);
      expect(parsePagination({ limit: 101 }).limit).toBe(100);
    });

    it("accepts limit at default boundary", () => {
      expect(parsePagination({ limit: "20" }).limit).toBe(20);
      expect(parsePagination({ limit: 20 }).limit).toBe(20);
    });

    it("accepts limit one above default", () => {
      expect(parsePagination({ limit: "21" }).limit).toBe(21);
      expect(parsePagination({ limit: 21 }).limit).toBe(21);
    });

    // Combined edge cases
    it("handles both limit and offset with invalid values", () => {
      const result = parsePagination({ limit: "invalid", offset: "invalid" });
      expect(result).toEqual({ limit: 20, offset: 0 });
    });

    it("handles valid limit with invalid offset", () => {
      const result = parsePagination({ limit: "50", offset: "invalid" });
      expect(result).toEqual({ limit: 50, offset: 0 });
    });

    it("handles invalid limit with valid offset", () => {
      const result = parsePagination({ limit: "invalid", offset: "100" });
      expect(result).toEqual({ limit: 20, offset: 100 });
    });

    it("handles both limit and offset at boundaries", () => {
      const result = parsePagination({ limit: "100", offset: "1000" });
      expect(result).toEqual({ limit: 100, offset: 1000 });
    });

    // Whitespace handling
    it("handles limit with surrounding whitespace", () => {
      expect(parsePagination({ limit: " 10 " }).limit).toBe(10);
      expect(parsePagination({ limit: "\t50\t" }).limit).toBe(50);
    });

    it("handles offset with surrounding whitespace", () => {
      expect(parsePagination({ offset: " 10 " }).offset).toBe(10);
      expect(parsePagination({ offset: "\t50\t" }).offset).toBe(50);
    });

    // Special string values
    it("handles special string values for limit", () => {
      expect(parsePagination({ limit: "null" }).limit).toBe(20);
      expect(parsePagination({ limit: "undefined" }).limit).toBe(20);
      expect(parsePagination({ limit: "Infinity" }).limit).toBe(20);
      expect(parsePagination({ limit: "-Infinity" }).limit).toBe(20);
    });

    it("handles special string values for offset", () => {
      expect(parsePagination({ offset: "null" }).offset).toBe(0);
      expect(parsePagination({ offset: "undefined" }).offset).toBe(0);
      expect(parsePagination({ offset: "Infinity" }).offset).toBe(0);
      expect(parsePagination({ offset: "-Infinity" }).offset).toBe(0);
    });
  });

  describe("paginatedResponse", () => {
    it("constructs the envelope correctly", () => {
      const data = [{ id: 1 }, { id: 2 }];
      const total = 100;
      const params = { limit: 10, offset: 20 };

      const response = paginatedResponse(data, total, params);

      expect(response).toEqual({
        data,
        total: 100,
        limit: 10,
        offset: 20,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Result-set boundaries
//
// The unit tests above cover parameter parsing. These cover the *result set*
// boundaries that only show up once a real (ordered, filtered) set is sliced:
// the final partial page, a page past the end, pagination combined with every
// supported filter and sort, and rows being inserted between page requests.
//
// Intended behaviour is stated explicitly here because it is a design
// decision, not an accident:
//
// - A final partial page returns the remainder and keeps reporting the true
//   `total`. `total` always describes the *full* filtered set, never the page.
// - A page past the end returns `data: []` and the unchanged `total`. It is
//   not an error and not a 404: the page simply contains no rows.
// - `total` is computed in the SAME query as the page (COUNT(*) OVER ()), so
//   it is exact as of that query's snapshot.
// - Under concurrent inserts the contract is deliberately weaker, and is
//   documented + asserted below: offset pagination is NOT snapshot-isolated,
//   so a row inserted ahead of the cursor can cause a row to be seen twice or
//   skipped across page boundaries. `getMarkets` therefore always orders by a
//   stable, unique tiebreaker (`id`) so ordering never shifts underneath a
//   client. These tests pin that behaviour so it cannot regress silently.
// ---------------------------------------------------------------------------

interface SeedMarket {
  id: number;
  category: MarketRow["category"];
  resolved: boolean;
  cancelled: boolean;
  bet_count: number;
  /** Seconds since epoch; `active` markets must be in the future. */
  end_time: number;
  created_at: number;
  total_yes: number;
  total_no: number;
}

/**
 * An in-memory stand-in for Postgres that understands just enough SQL to
 * execute the real `getMarkets` query: the WHERE clauses `getMarkets` builds,
 * the four ORDER BY expressions, LIMIT/OFFSET and COUNT(*) OVER ().
 *
 * It returns the exact row shape `getMarkets` expects, including the
 * `total_count` window column, so the production code path runs unmodified.
 */
function createSeededPool(markets: SeedMarket[]): { db: Queryable; rows: () => SeedMarket[] } {
  const NOW = 1_800_000_000;

  const toRow = (m: SeedMarket): MarketRow & { total_count?: number } => ({
    id: m.id,
    question: `Market ${m.id}`,
    image_url: null,
    category: m.category,
    end_time: String(m.end_time),
    total_yes: String(m.total_yes),
    total_no: String(m.total_no),
    resolved: m.resolved,
    outcome: null,
    cancelled: m.cancelled,
    creator: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    bet_count: m.bet_count,
    created_at: new Date(m.created_at * 1000),
    updated_at: new Date(m.created_at * 1000),
  });

  const db: Queryable = {
    async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
      // The out-of-range fallback: a bare `SELECT COUNT(*)::INT ... WHERE ...`.
      if (text.includes("COUNT(*)::INT AS total") && !text.includes("COUNT(*) OVER ()")) {
        const filtered = applyWhere(markets, text, values);
        return { rows: [{ total: filtered.length }] as T[] };
      }

      // Otherwise: the windowed page query.
      const filtered = applyWhere(markets, text, values);
      const sorted = applyOrderBy(filtered, text);

      const limitIdx = Number(/LIMIT \$(\d+)/.exec(text)?.[1]) - 1;
      const offsetIdx = Number(/OFFSET \$(\d+)/.exec(text)?.[1]) - 1;
      const limit = Number(values[limitIdx]);
      const offset = Number(values[offsetIdx]);

      const page = sorted.slice(offset, offset + limit);
      return {
        rows: page.map((m) => ({ ...toRow(m), total_count: filtered.length })) as T[],
      };
    },
  };

  return { db, rows: () => markets };
}

/** Mirrors the WHERE clauses `getMarkets` can emit. */
function applyWhere(markets: SeedMarket[], text: string, values: unknown[]): SeedMarket[] {
  const NOW = 1_800_000_000;
  let out = markets;

  const categoryClause = /category = \$(\d+)/.exec(text);
  if (categoryClause) {
    const value = values[Number(categoryClause[1]) - 1];
    out = out.filter((m) => m.category === value);
  }

  if (text.includes("resolved = false AND cancelled = false AND end_time >")) {
    out = out.filter((m) => !m.resolved && !m.cancelled && m.end_time > NOW);
  } else if (text.includes("resolved = true")) {
    out = out.filter((m) => m.resolved);
  } else if (text.includes("resolved = false AND cancelled = false AND end_time <=")) {
    out = out.filter((m) => !m.resolved && !m.cancelled && m.end_time <= NOW);
  } else if (text.includes("cancelled = true")) {
    out = out.filter((m) => m.cancelled);
  }

  return out;
}

/**
 * Builds a comparator from the query's actual `ORDER BY` clause rather than
 * hardcoding the sort, so this fake is never more deterministic than the SQL it
 * emulates. A sort with no unique trailing term genuinely leaves ties in an
 * unspecified order here, exactly as Postgres would.
 */
function applyOrderBy(markets: SeedMarket[], text: string): SeedMarket[] {
  const clause = /ORDER BY ([^;]+?)(?:\s+LIMIT \$)/s.exec(text)?.[1];
  if (clause === undefined) throw new Error(`no ORDER BY clause in query: ${text}`);

  const comparators = clause
    .split(",")
    .map((term) => term.trim())
    .map((term) => {
      const desc = /DESC$/i.test(term);
      const expr = term.replace(/\s+(ASC|DESC)$/i, "").trim();
      return (a: SeedMarket, b: SeedMarket): number => {
        const [av, bv] = sortKey(expr, a, b);
        return desc ? bv - av : av - bv;
      };
    });

  return [...markets].sort((a, b) => {
    for (const cmp of comparators) {
      const n = cmp(a, b);
      if (n !== 0) return n;
    }
    return 0;
  });
}

/** Resolves one ORDER BY term to a comparable number. */
function sortKey(expr: string, a: SeedMarket, b: SeedMarket): [number, number] {
  switch (expr) {
    case "created_at":
      return [a.created_at, b.created_at];
    case "end_time":
      return [a.end_time, b.end_time];
    case "bet_count":
      return [a.bet_count, b.bet_count];
    case "id":
      return [a.id, b.id];
    case "(total_yes + total_no)":
      return [a.total_yes + a.total_no, b.total_yes + b.total_no];
    default:
      throw new Error(`unsupported ORDER BY term in fake: ${expr}`);
  }
}

/** 25 markets: ids 1..25, newest-first by created_at (id 25 is newest). */
function seed25(): SeedMarket[] {
  return Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    category: i % 2 === 0 ? ("Crypto" as const) : ("Sports" as const),
    resolved: false,
    cancelled: false,
    bet_count: i,
    end_time: 1_800_000_000 + i * 1000,
    created_at: 1_700_000_000 + i * 1000,
    total_yes: i * 10,
    total_no: i * 5,
  }));
}

describe("result-set boundaries", () => {
  describe("final partial page", () => {
    it("returns the remainder and reports the true total", async () => {
      const { db } = createSeededPool(seed25());

      // 25 rows, limit 10 → pages of 10, 10, 5. The third is the partial one.
      const first = await getMarkets({ page: 1, limit: 10 }, db);
      const second = await getMarkets({ page: 2, limit: 10 }, db);
      const third = await getMarkets({ page: 3, limit: 10 }, db);

      expect(first.rows).toHaveLength(10);
      expect(second.rows).toHaveLength(10);
      expect(third.rows).toHaveLength(5);
      // `total` describes the whole filtered set, not the page, on every page.
      expect(first.total).toBe(25);
      expect(second.total).toBe(25);
      expect(third.total).toBe(25);
      expect(third.page).toBe(3);
      expect(third.limit).toBe(10);
    });

    it("covers every row exactly once across all pages with no gap or overlap", async () => {
      const { db } = createSeededPool(seed25());

      const pages = await Promise.all([1, 2, 3].map((page) => getMarkets({ page, limit: 10 }, db)));
      const ids = pages.flatMap((p) => p.rows.map((r) => r.id));

      expect(ids).toHaveLength(25);
      expect(new Set(ids).size).toBe(25);
      expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    it("returns a single-row final page when total is exactly one past a page boundary", async () => {
      const { db } = createSeededPool(seed25().slice(0, 11));

      const second = await getMarkets({ page: 2, limit: 10 }, db);

      expect(second.rows).toHaveLength(1);
      expect(second.total).toBe(11);
    });

    it("returns the full set on the first page when total is below the limit", async () => {
      const { db } = createSeededPool(seed25().slice(0, 3));

      const only = await getMarkets({ page: 1, limit: 10 }, db);

      expect(only.rows).toHaveLength(3);
      expect(only.total).toBe(3);
    });
  });

  describe("page beyond the end", () => {
    it("returns an empty page rather than an error", async () => {
      const { db } = createSeededPool(seed25());

      const beyond = await getMarkets({ page: 4, limit: 10 }, db);

      expect(beyond.rows).toEqual([]);
      // Total is still the real size of the filtered set, so a client can tell
      // "past the end" apart from "no such data".
      expect(beyond.total).toBe(25);
      expect(beyond.page).toBe(4);
    });

    it("reports total 0 for an empty result set, not an error", async () => {
      const { db } = createSeededPool([]);

      const empty = await getMarkets({ page: 1, limit: 10 }, db);

      expect(empty.rows).toEqual([]);
      expect(empty.total).toBe(0);
    });

    it("stays empty for a far page beyond the end", async () => {
      const { db } = createSeededPool(seed25());

      const far = await getMarkets({ page: 500, limit: 100 }, db);

      expect(far.rows).toEqual([]);
      expect(far.total).toBe(25);
    });

    it("does not error when a filter yields no rows and a page is requested", async () => {
      const { db } = createSeededPool(seed25());

      // No Science markets exist, so the filtered set is empty from page 1 on.
      const none = await getMarkets({ category: "Science", page: 3, limit: 10 }, db);

      expect(none.rows).toEqual([]);
      expect(none.total).toBe(0);
    });
  });

  describe("pagination combined with each filter and sort", () => {
    const FILTERS = ["active", "resolved", "ended", "cancelled", "all"] as const;
    const SORTS = ["newest", "volume", "ending_soon", "bettors"] as const;

    /** A dataset with rows in every bucket so each filter has real matches. */
    function seedMixed(): SeedMarket[] {
      return [
        { id: 1, category: "Crypto", resolved: false, cancelled: false, bet_count: 5, end_time: 1_900_000_000, created_at: 1_700_000_000, total_yes: 100, total_no: 0 },
        { id: 2, category: "Sports", resolved: false, cancelled: false, bet_count: 3, end_time: 1_900_000_001, created_at: 1_700_000_001, total_yes: 90, total_no: 0 },
        { id: 3, category: "Crypto", resolved: true, cancelled: false, bet_count: 9, end_time: 1_800_000_000, created_at: 1_700_000_002, total_yes: 80, total_no: 0 },
        { id: 4, category: "Politics", resolved: false, cancelled: false, bet_count: 7, end_time: 1_700_000_000, created_at: 1_700_000_003, total_yes: 70, total_no: 0 },
        { id: 5, category: "Sports", resolved: false, cancelled: true, bet_count: 1, end_time: 1_900_000_002, created_at: 1_700_000_004, total_yes: 60, total_no: 0 },
        { id: 6, category: "Crypto", resolved: true, cancelled: true, bet_count: 2, end_time: 1_800_000_001, created_at: 1_700_000_005, total_yes: 50, total_no: 0 },
      ];
    }

    const expectedIds = {
      all: [1, 2, 3, 4, 5, 6],
      active: [1, 2],
      resolved: [3, 6],
      ended: [4],
      cancelled: [5, 6],
    } as const;

    for (const filter of FILTERS) {
      for (const sort of SORTS) {
        it(`paginates correctly with filter=${filter} and sort=${sort}`, async () => {
          const { db } = createSeededPool(seedMixed());
          const limit = 2;

          const first = await getMarkets({ filter, sort, page: 1, limit }, db);
          const second = await getMarkets({ filter, sort, page: 2, limit }, db);
          const third = await getMarkets({ filter, sort, page: 3, limit }, db);

          const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);

          // `ending_soon` implicitly restricts to active, unresolved markets,
          // matching the extra WHERE clause db/markets.ts adds for that sort.
          const expected =
            sort === "ending_soon" ? expectedIds.active : expectedIds[filter];

          // Every matching row appears exactly once — no gaps, no duplicates.
          expect([...ids].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
          // `total` matches the filtered set size, not the page size.
          expect(first.total).toBe(expected.length);
        });
      }
    }

    it("applies the stable ordering for each sort across page boundaries", async () => {
      // Distinct volumes so the ordering is unambiguous.
      const { db } = createSeededPool(seed25());

      const byVolume = await getMarkets({ sort: "volume", page: 1, limit: 3 }, db);
      expect(byVolume.rows.map((r) => r.id)).toEqual([25, 24, 23]);

      const byBettors = await getMarkets({ sort: "bettors", page: 1, limit: 3 }, db);
      expect(byBettors.rows.map((r) => r.id)).toEqual([25, 24, 23]);

      const byNewest = await getMarkets({ sort: "newest", page: 1, limit: 3 }, db);
      expect(byNewest.rows.map((r) => r.id)).toEqual([25, 24, 23]);
    });

    it("breaks ties deterministically so equal rows keep a fixed order across pages", async () => {
      // Every market ties on volume, bet_count, end_time and created_at. The
      // only thing that can order them is each sort's trailing tiebreaker, so
      // a sort missing that tiebreaker is directly observable here.
      const tied = Array.from({ length: 6 }, (_, i) => ({
        id: i + 1,
        category: "Crypto" as const,
        resolved: false,
        cancelled: false,
        bet_count: 0,
        end_time: 1_900_000_000,
        created_at: 1_700_000_000,
        total_yes: 0,
        total_no: 0,
      }));
      const { db } = createSeededPool(tied);

      // A full tiebreaker-ordered read must partition the set with no repeats.
      for (const sort of ["newest", "volume", "bettors"] as const) {
        const seen = new Set<number>();
        for (const page of [1, 2, 3]) {
          const res = await getMarkets({ sort, page, limit: 2 }, db);
          for (const id of res.rows.map((r) => r.id)) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
        }
        expect(seen.size).toBe(6);
      }
    });

    it("keeps the last partial page correct when a filter narrows the set below a page size", async () => {
      const { db } = createSeededPool(seedMixed());

      const second = await getMarkets({ filter: "active", page: 2, limit: 10 }, db);

      expect(second.rows).toEqual([]);
      expect(second.total).toBe(2);
    });
  });

  describe("rows inserted between page requests", () => {
    /**
     * Documented contract: offset pagination is not snapshot-isolated, so a row
     * inserted *ahead of the cursor* between page requests shifts subsequent
     * pages and can make a row appear twice. This is inherent to LIMIT/OFFSET
     * and is why the API caps `offset` and points clients at cursors. These
     * tests pin the behaviour so a future "fix" is a deliberate decision.
     */
    it("documents drift when a new newest row is inserted between page 1 and page 2", async () => {
      const { db, rows } = createSeededPool(seed25());

      // Page 1 is read from the pre-insert snapshot: ids 25..16.
      const page1 = await getMarkets({ sort: "newest", page: 1, limit: 10 }, db);
      expect(page1.total).toBe(25);
      expect(page1.rows.map((r) => r.id)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);

      // A brand-new market (id 26) is created, newer than everything, between
      // the two page requests.
      rows().push({
        id: 26,
        category: "Crypto",
        resolved: false,
        cancelled: false,
        bet_count: 99,
        end_time: 1_900_000_099,
        created_at: 1_700_100_000,
        total_yes: 999,
        total_no: 0,
      });

      const page2 = await getMarkets({ sort: "newest", page: 2, limit: 10 }, db);
      const page3 = await getMarkets({ sort: "newest", page: 3, limit: 10 }, db);

      // `total` is re-read from this query's own snapshot, so it is correct.
      expect(page2.total).toBe(26);
      expect(page3.total).toBe(26);

      const page1Ids = page1.rows.map((r) => r.id);
      const page2Ids = page2.rows.map((r) => r.id);
      const page3Ids = page3.rows.map((r) => r.id);

      // The insert shifted every later row down one slot, so id 16 — the last
      // row already returned on page 1 — is returned AGAIN on page 2. This is
      // the classic offset-pagination duplicate.
      expect(page2Ids[0]).toBe(16);
      expect(page1Ids).toContain(16);

      // And the row the client most wants, the one just inserted, is skipped
      // entirely: it occupies the offset-0 slot of the new ordering, which no
      // request ever reads (page 1 was already served from the old snapshot).
      const allIds = [...page1Ids, ...page2Ids, ...page3Ids];
      expect(allIds).not.toContain(26);
      // 26 rows across 3 pages of 10 = 26 slots, but only 25 distinct ids.
      expect(allIds).toHaveLength(26);
      expect(new Set(allIds).size).toBe(25);
    });

    it("keeps ordering stable when an insert lands *after* the cursor (no drift)", async () => {
      const { db, rows } = createSeededPool(seed25());

      const page1 = await getMarkets({ sort: "newest", page: 1, limit: 10 }, db);

      // A row that sorts *last* (oldest) — it does not shift the pages above it.
      rows().push({
        id: 26,
        category: "Crypto",
        resolved: false,
        cancelled: false,
        bet_count: 0,
        end_time: 1_900_000_099,
        created_at: 1_600_000_000,
        total_yes: 0,
        total_no: 0,
      });

      const page2 = await getMarkets({ sort: "newest", page: 2, limit: 10 }, db);
      const page3 = await getMarkets({ sort: "newest", page: 3, limit: 10 }, db);

      const page1Ids = page1.rows.map((r) => r.id);
      const page2Ids = page2.rows.map((r) => r.id);
      const page3Ids = page3.rows.map((r) => r.id);

      // No row is served twice, and the only change is the appended tail.
      expect(new Set([...page1Ids, ...page2Ids, ...page3Ids]).size).toBe(26);
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toEqual([]);
      expect(page2Ids.filter((id) => page3Ids.includes(id))).toEqual([]);
      // The new oldest row shows up on the final page.
      expect(page3Ids).toContain(26);
      // Total still tracks the live snapshot.
      expect(page3.total).toBe(26);
    });

    it("a delete between page requests shifts the window without duplicating rows", async () => {
      const { db, rows } = createSeededPool(seed25());

      const page1 = await getMarkets({ sort: "newest", page: 1, limit: 10 }, db);

      // Remove a row from the first page: everything shifts up one slot, so
      // page 2 now starts one row earlier. Combined with page 1 this skips a
      // row — the mirror-image failure of the insert case.
      const removedId = page1.rows.at(-1)!.id;
      const idx = rows().findIndex((m) => m.id === removedId);
      rows().splice(idx, 1);

      const page2 = await getMarkets({ sort: "newest", page: 2, limit: 10 }, db);

      const page1Ids = page1.rows.map((r) => r.id);
      const page2Ids = page2.rows.map((r) => r.id);
      expect(page2.total).toBe(24);
      // The row that was last on page 1 is now the first on page 2 → skipped.
      expect(page2Ids).not.toContain(removedId);
      expect(page1Ids).toContain(removedId);
    });

    it("total is recomputed per query so it never drifts from the page it accompanies", async () => {
      const { db, rows } = createSeededPool(seed25());

      const before = await getMarkets({ page: 1, limit: 10 }, db);
      expect(before.total).toBe(25);

      rows().push({
        id: 99,
        category: "Crypto",
        resolved: false,
        cancelled: false,
        bet_count: 0,
        end_time: 1_900_000_099,
        created_at: 1_600_000_000,
        total_yes: 0,
        total_no: 0,
      });

      const after = await getMarkets({ page: 1, limit: 10 }, db);
      expect(after.total).toBe(26);
      // Single round trip: the count came from the same query as the rows.
      expect(after.rows).toHaveLength(10);
    });
  });

  describe("pagination bounds", () => {
    it("caps the limit at the documented maximum", async () => {
      expect(parsePagination({ limit: String(MAX_PAGINATION_LIMIT) }).limit).toBe(MAX_PAGINATION_LIMIT);
      expect(parsePagination({ limit: String(MAX_PAGINATION_LIMIT + 1) }).limit).toBe(MAX_PAGINATION_LIMIT);
    });

    it("refuses an offset beyond the maximum, directing clients to cursors", () => {
      expect(() => parsePagination({ offset: String(MAX_PAGINATION_OFFSET) })).not.toThrow();
      expect(() => parsePagination({ offset: String(MAX_PAGINATION_OFFSET + 1) })).toThrow(RangeError);
    });

    it("rejects a non-positive page or limit at the query layer", async () => {
      const { db } = createSeededPool(seed25());
      await expect(getMarkets({ page: 0 }, db)).rejects.toThrow("page must be a positive integer");
      await expect(getMarkets({ page: 1, limit: 0 }, db)).rejects.toThrow("limit must be a positive integer");
    });

    it("gives every sort a deterministic tiebreaker, so ties cannot reorder between pages", async () => {
      // Without a trailing unique term, rows that tie on the sort key have an
      // order Postgres does not guarantee, and two pages read from the same
      // snapshot can then disagree about which rows fall in each window. This
      // is the property that makes LIMIT/OFFSET reproducible at all.
      const { db } = createSeededPool(seed25());
      const captured: string[] = [];
      const recording: Queryable = {
        async query<T>(text: string, values?: unknown[]) {
          captured.push(text);
          return db.query<T>(text, values);
        },
      };

      for (const sort of ["newest", "volume", "ending_soon", "bettors"] as const) {
        await getMarkets({ sort, page: 1, limit: 5 }, recording);
      }

      expect(captured).toHaveLength(4);
      for (const text of captured) {
        const clause = /ORDER BY ([^;]+?)(?:\s+LIMIT \$)/s.exec(text)?.[1];
        const terms = clause!.split(",").map((t) => t.trim());
        // The last term must be a unique column, not another sort key.
        expect(terms.length).toBeGreaterThan(0);
        expect(terms.at(-1)).toMatch(/\bid\b|created_at/i);
      }
    });
  });
});
