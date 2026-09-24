import { describe, it, expect } from "vitest";
import { parsePagination, paginatedResponse } from "../lib/pagination";

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

    it("accepts very large offset values", () => {
      expect(parsePagination({ offset: "1000" }).offset).toBe(1000);
      expect(parsePagination({ offset: "999999" }).offset).toBe(999999);
      expect(parsePagination({ offset: Number.MAX_SAFE_INTEGER }).offset).toBe(Number.MAX_SAFE_INTEGER);
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
