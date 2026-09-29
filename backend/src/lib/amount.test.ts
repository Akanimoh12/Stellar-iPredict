import { describe, expect, it, vi } from "vitest";
import {
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
  xlmToStroopsNumber,
  addXlmAmounts,
  configurePgNumericParser,
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

  describe("boundary and beyond-boundary values (Issue #487)", () => {
    const SAFE_INT_MAX_BIGINT = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991n
    const BEYOND_SAFE_INT = 9_007_199_254_740_992n; // Number.MAX_SAFE_INTEGER + 1
    const HUGE_AMOUNT = 100_000_000_000_000_000_000n; // 10^20 stroops
    // i128::MAX = 2^127 - 1 (Stellar maximum balance / amount range)
    const MAX_I128_STROOPS = 170141183460469231731687303715884105727n;
    // NUMERIC(30,7) maximum in PostgreSQL
    const MAX_NUMERIC_30_7_XLM = "99999999999999999999999.9999999";
    const MAX_NUMERIC_30_7_STROOPS = 999999999999999999999999999999n;

    it("round-trips amounts at Number.MAX_SAFE_INTEGER exactly", () => {
      const xlm = stroopsToXlm(SAFE_INT_MAX_BIGINT);
      expect(xlmToStroops(xlm)).toBe(SAFE_INT_MAX_BIGINT);
    });

    it("round-trips amounts strictly larger than Number.MAX_SAFE_INTEGER exactly", () => {
      for (const val of [
        BEYOND_SAFE_INT,
        HUGE_AMOUNT,
        MAX_I128_STROOPS,
        MAX_NUMERIC_30_7_STROOPS,
      ]) {
        const xlm = stroopsToXlm(val);
        const back = xlmToStroops(xlm);
        expect(back).toBe(val);
      }
    });

    it("round-trips string XLM amounts beyond Number.MAX_SAFE_INTEGER exactly", () => {
      const xlmValues = [
        "9007199254740992.1234567",
        "100000000000000.0000001",
        MAX_NUMERIC_30_7_XLM,
      ];
      for (const xlm of xlmValues) {
        const stroops = xlmToStroops(xlm);
        expect(stroopsToXlm(stroops)).toBe(xlm);
      }
    });

    it("rejects numbers exceeding Number.MAX_SAFE_INTEGER to prevent loss of precision", () => {
      expect(() => xlmToStroops(Number.MAX_SAFE_INTEGER + 100)).toThrow(
        "xlm must be a non-negative decimal with at most 7 decimal places"
      );
      expect(() => xlmToStroops(1e18)).toThrow(
        "xlm must be a non-negative decimal with at most 7 decimal places"
      );
    });

    it("adds XLM amounts exactly without floating point drift via addXlmAmounts", () => {
      const a = "9007199254740992.5000000";
      const b = "1000000000000000.5000000";
      const sum = addXlmAmounts(a, b);
      expect(sum).toBe("10007199254740993.0000000");
    });
  });

  describe("pg NUMERIC type parser configuration", () => {
    it("configures pg types to return NUMERIC (OID 1700) as raw string", () => {
      const setTypeParserMock = vi.fn();
      configurePgNumericParser({
        setTypeParser: setTypeParserMock,
        builtins: { NUMERIC: 1700 },
      });

      expect(setTypeParserMock).toHaveBeenCalledWith(1700, expect.any(Function));
      const parserFn = setTypeParserMock.mock.calls[0][1];
      const largeNumeric = "99999999999999999999999.9999999";
      expect(parserFn(largeNumeric)).toBe(largeNumeric);
    });
  });
});

