import { describe, expect, it } from "vitest";

import {
  createPaginatedResponse,
  paginatedResponse,
  parsePagination,
  parsePaginationParams,
} from "../src/lib/pagination.js";

describe("parsePagination — defaults", () => {
  it("uses the default limit and a zero offset when nothing is supplied", () => {
    expect(parsePagination({})).toEqual({ limit: 20, offset: 0 });
  });

  it("treats explicit null / undefined as absent", () => {
    expect(parsePagination({ limit: null, offset: undefined })).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it("honours caller-provided default and max limits", () => {
    expect(parsePagination({}, 5, 10)).toEqual({ limit: 5, offset: 0 });
    expect(parsePagination({ limit: "999" }, 5, 10)).toEqual({ limit: 10, offset: 0 });
  });
});

describe("parsePagination — valid input", () => {
  it("parses numeric strings and numbers", () => {
    expect(parsePagination({ limit: "50", offset: "100" })).toEqual({
      limit: 50,
      offset: 100,
    });
    expect(parsePagination({ limit: 25, offset: 0 })).toEqual({ limit: 25, offset: 0 });
  });

  it("clamps an over-large limit and rejects an offset beyond the global maximum", () => {
    expect(parsePagination({ limit: "1000", offset: "10000" })).toEqual({
      limit: 100,
      offset: 10_000,
    });
    expect(() => parsePagination({ limit: "1000", offset: "1000000" })).toThrow(
      "Use cursor-based pagination for deeper results",
    );
  });

  it("truncates fractional values (parseInt semantics)", () => {
    expect(parsePagination({ limit: "10.9", offset: "3.9" })).toEqual({
      limit: 10,
      offset: 3,
    });
  });

  it("accepts a leading-numeric string like parseInt does", () => {
    expect(parsePagination({ limit: "15abc", offset: "7xyz" })).toEqual({
      limit: 15,
      offset: 7,
    });
  });
});

describe("parsePagination — edge cases (issue #242)", () => {
  it("falls back to defaults for non-numeric input", () => {
    expect(parsePagination({ limit: "abc", offset: "xyz" })).toEqual({
      limit: 20,
      offset: 0,
    });
    expect(parsePagination({ limit: {}, offset: [] })).toEqual({ limit: 20, offset: 0 });
    expect(parsePagination({ limit: true, offset: false })).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it("rejects a zero or negative limit (must be > 0)", () => {
    expect(parsePagination({ limit: "0" }).limit).toBe(20);
    expect(parsePagination({ limit: "-5" }).limit).toBe(20);
    expect(parsePagination({ limit: -1 }).limit).toBe(20);
  });

  it("rejects a negative offset (must be >= 0) but allows zero", () => {
    expect(parsePagination({ offset: "-1" }).offset).toBe(0);
    expect(parsePagination({ offset: -10 }).offset).toBe(0);
    expect(parsePagination({ offset: "0" }).offset).toBe(0);
  });

  it("clamps a huge limit but rejects a huge offset", () => {
    const huge = `1${"0".repeat(20)}`;
    expect(parsePagination({ limit: huge }).limit).toBe(100);
    expect(() => parsePagination({ offset: huge })).toThrow("exceeds the maximum");
  });

  it("rejects an overflowing offset while still clamping an overflowing limit", () => {
    const overflow = "9".repeat(400);
    expect(parsePagination({ limit: overflow }).limit).toBe(100);
    expect(() => parsePagination({ offset: overflow })).toThrow("exceeds the maximum");
  });

  it("handles Infinity / NaN number inputs by falling back", () => {
    expect(parsePagination({ limit: Number.POSITIVE_INFINITY })).toEqual({
      limit: 20,
      offset: 0,
    });
    expect(parsePagination({ limit: Number.NaN, offset: Number.NaN })).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it("array query values (?limit=1&limit=2) fall back rather than mis-parsing", () => {
    // Express-style repeated params arrive as arrays; String([1,2]) === "1,2"
    // -> parseInt("1,2") === 1, still a positive int, so limit becomes 1.
    expect(parsePagination({ limit: [1, 2] }).limit).toBe(1);
    // A non-leading-numeric array falls back.
    expect(parsePagination({ limit: ["a", "b"] }).limit).toBe(20);
  });

  it("is a pure function — repeated calls give the same result", () => {
    const q = { limit: "37", offset: "12" };
    expect(parsePagination(q)).toEqual(parsePagination(q));
    expect(q).toEqual({ limit: "37", offset: "12" }); // input not mutated
  });
});

describe("paginatedResponse envelope", () => {
  it("wraps data with total and the resolved params", () => {
    const params = parsePagination({ limit: "10", offset: "20" });
    expect(paginatedResponse([1, 2, 3], 42, params)).toEqual({
      data: [1, 2, 3],
      total: 42,
      limit: 10,
      offset: 20,
    });
  });

  it("exposes backward-compatible aliases", () => {
    expect(parsePaginationParams).toBe(parsePagination);
    expect(createPaginatedResponse).toBe(paginatedResponse);
  });
});
