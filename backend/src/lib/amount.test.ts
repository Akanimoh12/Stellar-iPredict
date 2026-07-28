import { describe, expect, it } from "vitest";

import { stroopsToXlm, xlmToStroops } from "./amount.js";

describe("amount conversions", () => {
  describe("stroopsToXlm", () => {
    it("formats amounts with seven decimal places", () => {
      expect(stroopsToXlm(0)).toBe("0.0000000");
      expect(stroopsToXlm(1)).toBe("0.0000001");
      expect(stroopsToXlm(10_000_000)).toBe("1.0000000");
      expect(stroopsToXlm("12345678901234567890")).toBe("1234567890123.4567890");
    });

    it("preserves negative amounts without floating-point arithmetic", () => {
      expect(stroopsToXlm(-1_500_000)).toBe("-0.1500000");
    });

    it("rejects non-integer stroop values", () => {
      expect(() => stroopsToXlm(1.5)).toThrow(RangeError);
      expect(() => stroopsToXlm("1.5")).toThrow(TypeError);
    });
  });

  describe("xlmToStroops", () => {
    it("converts decimal XLM values exactly", () => {
      expect(xlmToStroops("0")).toBe(0n);
      expect(xlmToStroops("0.0000001")).toBe(1n);
      expect(xlmToStroops("1")).toBe(10_000_000n);
      expect(xlmToStroops("1234567890123.4567890")).toBe(12_345_678_901_234_567_890n);
    });

    it("accepts numeric values when they can be represented as decimals", () => {
      expect(xlmToStroops(1.25)).toBe(12_500_000n);
    });

    it("rejects values with more than seven decimal places", () => {
      expect(() => xlmToStroops("1.00000001")).toThrow(RangeError);
    });

    it("rejects malformed or non-finite values", () => {
      expect(() => xlmToStroops("not-an-amount")).toThrow(TypeError);
      expect(() => xlmToStroops(Infinity)).toThrow(TypeError);
    });
  });
});
