import { describe, expect, it } from "vitest";
import {
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
  xlmToStroopsNumber,
} from "./amount.js";

describe("amount conversion", () => {
  it("exposes the seven-decimal XLM scale", () => {
    expect(STROOPS_PER_XLM).toBe(10_000_000);
  });

  it("formats stroops as fixed seven-decimal XLM", () => {
    expect(stroopsToXlm(0)).toBe("0.0000000");
    expect(stroopsToXlm(1)).toBe("0.0000001");
    expect(stroopsToXlm(10_000_000)).toBe("1.0000000");
    expect(stroopsToXlm("12345678901234567890")).toBe("1234567890123.4567890");
  });

  it("converts XLM to exact stroops without floating-point arithmetic", () => {
    expect(xlmToStroops("0")).toBe(0n);
    expect(xlmToStroops(0.0000001)).toBe(1n);
    expect(xlmToStroops(1.5)).toBe(15_000_000n);
    expect(xlmToStroops("1234567890123.4567890")).toBe(12_345_678_901_234_567_890n);
  });

  it("rejects values with more than seven decimal places", () => {
    expect(() => xlmToStroops("1.00000001")).toThrow(
      "xlm must be a non-negative decimal with at most 7 decimal places"
    );
    expect(() => xlmToStroops(1.00000001)).toThrow(
      "xlm must be a non-negative decimal with at most 7 decimal places"
    );
  });

  it("provides a safe number conversion when requested", () => {
    expect(xlmToStroopsNumber("1.5")).toBe(15_000_000);
    expect(() => xlmToStroopsNumber("900719925474.0995800")).toThrow(
      "stroop amount exceeds Number.MAX_SAFE_INTEGER"
    );
  });
});
