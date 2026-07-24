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
