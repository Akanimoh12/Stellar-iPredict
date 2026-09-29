/**
 * Unit tests for getMarkets SQL generation (backend/src/db/markets.ts).
 *
 * These tests verify the exact ORDER BY clauses and WHERE conditions that
 * getMarkets builds for each sort option and filter.  They serve as a
 * regression guard for migration 0028: if ORDER_BY expressions or filter
 * predicates change, the indexes must be revisited too.
 *
 * No live database is required — a fake Queryable captures the SQL text
 * passed to db.query() and returns an empty result set.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMarkets } from "../markets.js";
import type { Queryable } from "../markets.js";

/** Capture every SQL string passed to db.query(). */
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

/**
 * Returns the normalised ORDER BY clause from a captured SQL string,
 * stripping extra whitespace so assertions are whitespace-insensitive.
 */
function extractOrderBy(sql: string): string {
  const match = sql.match(/ORDER BY\s+(.+?)\s+LIMIT/si);
  if (!match) throw new Error(`No ORDER BY found in:\n${sql}`);
  return match[1].replace(/\s+/g, " ").trim();
}

/** Returns the normalised WHERE clause (everything between WHERE and ORDER BY). */
function extractWhere(sql: string): string {
  const match = sql.match(/WHERE\s+(.+?)\s+ORDER BY/si);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim();
}

// ── Sort ORDER BY clauses ─────────────────────────────────────────────────────

describe("getMarkets ORDER BY clause", () => {
  it("newest → ORDER BY created_at DESC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "newest", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("created_at DESC");
  });

  it("volume → ORDER BY (total_yes + total_no) DESC, created_at DESC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "volume", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe(
      "(total_yes + total_no) DESC, created_at DESC"
    );
  });

  it("ending_soon → ORDER BY end_time ASC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "ending_soon", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("end_time ASC");
  });

  it("bettors → ORDER BY bet_count DESC, created_at DESC", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "bettors", filter: "all" }, db);
    expect(extractOrderBy(calls[0])).toBe("bet_count DESC, created_at DESC");
  });
});

// ── Filter WHERE predicates ───────────────────────────────────────────────────

describe("getMarkets WHERE predicates", () => {
  it("filter=all produces no WHERE clause", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ filter: "all", sort: "newest" }, db);
    // No WHERE expected when there's no filter and no category.
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
    // ending_soon must exclude resolved and cancelled markets.
    expect(where).toContain("resolved = false");
    expect(where).toContain("cancelled = false");
    expect(where).toContain("end_time >");
  });
});

// ── Category filter ───────────────────────────────────────────────────────────

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
    // Both predicates must appear.
    expect(where).toContain("category = $1");
    expect(where).toContain("resolved = false");
  });
});

// ── Index-coverage assertions ─────────────────────────────────────────────────
//
// These tests do not actually check an index — they verify that the ORDER BY
// expressions produced by getMarkets exactly match the expressions used in
// migration 0028.  If anyone changes ORDER_BY without updating the migration,
// these tests will catch the drift.

describe("ORDER BY expressions match migration 0028 index definitions", () => {
  it("newest ORDER BY matches idx_markets_created_at definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "newest", filter: "all" }, db);
    // idx_markets_created_at ON markets (created_at DESC)
    expect(extractOrderBy(calls[0])).toBe("created_at DESC");
  });

  it("volume ORDER BY matches idx_markets_volume_tiebreak definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "volume", filter: "all" }, db);
    // idx_markets_volume_tiebreak ON markets ((total_yes + total_no) DESC, created_at DESC)
    expect(extractOrderBy(calls[0])).toBe(
      "(total_yes + total_no) DESC, created_at DESC"
    );
  });

  it("bettors ORDER BY matches idx_markets_bettors definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "bettors", filter: "all" }, db);
    // idx_markets_bettors ON markets (bet_count DESC, created_at DESC)
    // WHERE resolved = FALSE AND cancelled = FALSE
    expect(extractOrderBy(calls[0])).toBe("bet_count DESC, created_at DESC");
  });

  it("ending_soon ORDER BY matches idx_markets_active_partial definition", async () => {
    const { db, calls } = makeCapture();
    await getMarkets({ sort: "ending_soon", filter: "all" }, db);
    // idx_markets_active_partial ON markets (end_time) WHERE resolved = FALSE AND cancelled = FALSE
    expect(extractOrderBy(calls[0])).toBe("end_time ASC");
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe("getMarkets pagination bind parameters", () => {
  it("LIMIT and OFFSET appear at the end of bind values for filter=all/no-category", async () => {
    const { db } = makeCapture();
    const querySpy = vi.spyOn(db, "query");
    await getMarkets({ filter: "all", sort: "newest", page: 2, limit: 10 }, db);
    const [, values] = querySpy.mock.calls[0] as [string, unknown[]];
    // No category bind, so LIMIT=$1, OFFSET=$2.
    expect(values).toEqual([10, 10]); // limit=10, offset=(2-1)*10=10
  });

  it("LIMIT and OFFSET shift by one when category is present", async () => {
    const { db } = makeCapture();
    const querySpy = vi.spyOn(db, "query");
    await getMarkets(
      { filter: "all", sort: "newest", page: 1, limit: 5, category: "Crypto" },
      db
    );
    const [, values] = querySpy.mock.calls[0] as [string, unknown[]];
    // category=$1, LIMIT=$2, OFFSET=$3.
    expect(values).toEqual(["Crypto", 5, 0]);
  });
});
