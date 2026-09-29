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

    it("falls back to OID 1700 when the driver exposes no builtins", () => {
      const setTypeParserMock = vi.fn();
      configurePgNumericParser({ setTypeParser: setTypeParserMock });

      expect(setTypeParserMock).toHaveBeenCalledWith(1700, expect.any(Function));
    });

    it("is an identity transform, so a boundary value survives it unchanged", () => {
      // Cross-boundary coverage for this parser lives in
      // test/amount-precision.test.ts; these cases pin the contract it relies
      // on — the parser never converts, formats, or rounds.
      const setTypeParserMock = vi.fn();
      configurePgNumericParser({ setTypeParser: setTypeParserMock, builtins: { NUMERIC: 1700 } });
      const parse = setTypeParserMock.mock.calls[0][1] as (value: string) => unknown;

      for (const value of [
        "0.0000000",
        "1.5000000",
        "900719925.4740991", // Number.MAX_SAFE_INTEGER stroops
        "99999999999999999999999.9999999", // NUMERIC(30,7) max
        "17014118346046923173168730371588.4105727", // i128::MAX stroops
      ]) {
        expect(typeof parse(value)).toBe("string");
        expect(parse(value)).toBe(value);
      }
    });
  });

  /**
   * P0 — cross-boundary coverage.
   *
   * The full contract → indexer → database → API path is exercised in
   * `backend/test/amount-precision.test.ts`, which is the only test able to
   * reach both packages. What is pinned here is the invariant that whole
   * stack rests on: a value too large for a JS number stays exact through
   * every conversion, and the one documented lossy escape hatch refuses to
   * return a value that has silently lost units.
   */
  describe("exactness invariants relied on by the cross-boundary suite", () => {
    const I128_MAX = 170141183460469231731687303715884105727n;
    const MAX_NUMERIC_30_7_STROOPS = 999999999999999999999999999999n;
    const BEYOND_SAFE_INT = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    it("round-trips i128::MAX through stroopsToXlm/xlmToStroops", () => {
      const xlm = stroopsToXlm(I128_MAX);
      expect(xlm).toBe("17014118346046923173168730371588.4105727");
      expect(xlmToStroops(xlm)).toBe(I128_MAX);
      expect(xlmToStroops(xlm).toString()).toBe(I128_MAX.toString());
    });

    it("round-trips the NUMERIC(30,7) maximum exactly", () => {
      const xlm = stroopsToXlm(MAX_NUMERIC_30_7_STROOPS);
      expect(xlm).toBe("99999999999999999999999.9999999");
      expect(xlmToStroops(xlm)).toBe(MAX_NUMERIC_30_7_STROOPS);
    });

    it("never routes a large value through a number, in either direction", () => {
      // `Number(...)` on these values is lossy; the point of the bigint and
      // string types is that the value never sees one.
      for (const stroops of [BEYOND_SAFE_INT, MAX_NUMERIC_30_7_STROOPS, I128_MAX]) {
        const xlm = stroopsToXlm(stroops);
        expect(xlmToStroops(xlm)).toBe(stroops);
        expect(xlmToStroops(xlm) === stroops).toBe(true);
      }
    });

    it("refuses to hand a large stroop amount to the deprecated number path", () => {
      expect(() => xlmToStroopsNumber(stroopsToXlm(MAX_NUMERIC_30_7_STROOPS))).toThrow(
        RangeError,
      );
      expect(() => xlmToStroopsNumber(stroopsToXlm(I128_MAX))).toThrow(RangeError);
    });

    it("adds two amounts past the safe integer range without drift", () => {
      const a = stroopsToXlm(MAX_NUMERIC_30_7_STROOPS);
      const b = "0.0000001";

      const sum = addXlmAmounts(a, b);
      // The carry out of an all-nines integer part is the case a float or a
      // truncated-string sum gets wrong, so it is asserted explicitly.
      expect(sum).toBe("100000000000000000000000.0000000");
      expect(xlmToStroops(sum)).toBe(MAX_NUMERIC_30_7_STROOPS + 1n);
    });
  });
});

