/**
 * Cross-package property tests for amount precision (#995).
 *
 * Backend, frontend and the shared helpers all convert stroops independently.
 * This suite exercises them against the same test vectors to prove that every
 * conversion layer agrees — no silent rounding, truncation or floating-point
 * drift anywhere along the path.
 *
 * Where: backend/src/lib/amount-precision.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  stroopsToXlm,
  xlmToStroops,
  addXlmAmounts,
  STROOPS_PER_XLM,
} from "./amount.js";

// ── Shared test vectors ───────────────────────────────────────────────────────
//
// Each vector represents a (stroops, xlmString) pair that every conversion
// layer must agree on. Adding a new vector here covers all layers at once.

interface AmountVector {
  stroops: bigint;
  xlm: string;
  label: string;
}

const VECTORS: AmountVector[] = [
  { stroops: 0n, xlm: "0.0000000", label: "zero" },
  { stroops: 1n, xlm: "0.0000001", label: "one stroop" },
  { stroops: 10n, xlm: "0.0000010", label: "ten stroops" },
  { stroops: 100n, xlm: "0.0000100", label: "one hundred stroops" },
  { stroops: 1_000_000n, xlm: "0.1000000", label: "0.1 XLM" },
  { stroops: 10_000_000n, xlm: "1.0000000", label: "1 XLM" },
  { stroops: 15_000_000n, xlm: "1.5000000", label: "1.5 XLM" },
  { stroops: 100_000_000n, xlm: "10.0000000", label: "10 XLM" },
  { stroops: 980_000_000n, xlm: "98.0000000", label: "98 XLM (net after 2% fee)" },
  { stroops: 1_960_000_000n, xlm: "196.0000000", label: "196 XLM (winner payout)" },
  {
    stroops: BigInt(Number.MAX_SAFE_INTEGER),
    xlm: "900719925.4740991",
    label: "Number.MAX_SAFE_INTEGER stroops",
  },
  {
    stroops: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    xlm: "900719925.4740992",
    label: "one above Number.MAX_SAFE_INTEGER",
  },
  {
    stroops: 9_007_199_254_740_992n,
    xlm: "900719925.4740992",
    label: "MAX_SAFE_INTEGER + 1 explicit",
  },
  {
    stroops: 100_000_000_000_000_000_000n,
    xlm: "10000000000000.0000000",
    label: "10^20 stroops",
  },
  {
    // i128::MAX — the largest value the Soroban smart contracts can hold
    stroops: 170_141_183_460_469_231_731_687_303_715_884_105_727n,
    xlm: "17014118346046923173168730371588.4105727",
    label: "i128::MAX",
  },
  {
    // NUMERIC(30,7) maximum — the PostgreSQL column type used for balances
    stroops: 999_999_999_999_999_999_999_999_999_999n,
    xlm: "99999999999999999999999.9999999",
    label: "NUMERIC(30,7) max",
  },
];

// ── Property: stroopsToXlm produces the canonical string ─────────────────────

describe("stroopsToXlm — shared test vectors", () => {
  for (const { stroops, xlm, label } of VECTORS) {
    it(`encodes ${label} as "${xlm}"`, () => {
      expect(stroopsToXlm(stroops)).toBe(xlm);
    });
  }
});

// ── Property: xlmToStroops round-trips every vector exactly ──────────────────

describe("xlmToStroops — shared test vectors", () => {
  for (const { stroops, xlm, label } of VECTORS) {
    it(`decodes "${xlm}" (${label}) back to ${stroops}n`, () => {
      expect(xlmToStroops(xlm)).toBe(stroops);
    });
  }
});

// ── Property: stroopsToXlm → xlmToStroops round-trip is lossless ─────────────

describe("round-trip losslessness across all vectors", () => {
  for (const { stroops, label } of VECTORS) {
    it(`round-trips ${label} without loss`, () => {
      const xlm = stroopsToXlm(stroops);
      expect(xlmToStroops(xlm)).toBe(stroops);
    });
  }
});

// ── Property: xlmToStroops → stroopsToXlm round-trip is lossless ─────────────

describe("XLM-string → stroops → XLM-string round-trip", () => {
  for (const { xlm, label } of VECTORS) {
    it(`round-trips "${xlm}" (${label}) without loss`, () => {
      const stroops = xlmToStroops(xlm);
      expect(stroopsToXlm(stroops)).toBe(xlm);
    });
  }
});

// ── Scale constant consistency ────────────────────────────────────────────────

describe("STROOPS_PER_XLM constant", () => {
  it("equals 10_000_000", () => {
    expect(STROOPS_PER_XLM).toBe(10_000_000);
  });

  it("matches the implicit scale in every vector", () => {
    for (const { stroops, xlm, label } of VECTORS) {
      // Parse the integer part from the canonical XLM string
      const [wholeStr, fracStr] = xlm.split(".");
      const wholeStroops = BigInt(wholeStr) * BigInt(STROOPS_PER_XLM);
      const fracStroops = BigInt((fracStr ?? "").padEnd(7, "0"));
      expect(wholeStroops + fracStroops).toBe(stroops);
    }
  });
});

// ── addXlmAmounts: exact addition without floating-point drift ────────────────

describe("addXlmAmounts across precision boundaries", () => {
  it("adds zero to a value unchanged", () => {
    expect(addXlmAmounts("1.5000000", "0.0000000")).toBe("1.5000000");
    expect(addXlmAmounts("0.0000000", "98.0000000")).toBe("98.0000000");
  });

  it("adds two sub-stroop-boundary values exactly", () => {
    expect(addXlmAmounts("0.0000001", "0.0000001")).toBe("0.0000002");
  });

  it("carries across the whole/fractional boundary without drift", () => {
    expect(addXlmAmounts("0.9999999", "0.0000001")).toBe("1.0000000");
  });

  it("adds values beyond Number.MAX_SAFE_INTEGER without floating-point drift", () => {
    const a = "900719925.4740991"; // MAX_SAFE_INTEGER stroops
    const b = "0.0000001";
    expect(addXlmAmounts(a, b)).toBe("900719925.4740992");
  });

  it("adds two large values beyond the safe integer range exactly", () => {
    const a = "9007199254740992.5000000";
    const b = "1000000000000000.5000000";
    expect(addXlmAmounts(a, b)).toBe("10007199254740993.0000000");
  });

  it("carries out of NUMERIC(30,7) max correctly", () => {
    const max = "99999999999999999999999.9999999";
    const one_stroop = "0.0000001";
    expect(addXlmAmounts(max, one_stroop)).toBe("100000000000000000000000.0000000");
  });
});

// ── Rejection properties ──────────────────────────────────────────────────────

describe("xlmToStroops — invalid input rejection", () => {
  const tooManyDecimals = [
    "1.00000001",
    "0.00000001",
    "1.12345678",
  ];

  for (const val of tooManyDecimals) {
    it(`rejects "${val}" (more than 7 decimal places)`, () => {
      expect(() => xlmToStroops(val)).toThrow(
        "xlm must be a non-negative decimal with at most 7 decimal places"
      );
    });
  }

  it("rejects negative string input", () => {
    expect(() => xlmToStroops("-1.0000000")).toThrow();
  });

  it("rejects non-numeric string input", () => {
    expect(() => xlmToStroops("abc")).toThrow();
  });

  it("rejects a JS number larger than MAX_SAFE_INTEGER", () => {
    expect(() => xlmToStroops(Number.MAX_SAFE_INTEGER + 100)).toThrow(
      "xlm must be a non-negative decimal with at most 7 decimal places"
    );
  });
});

describe("stroopsToXlm — always produces exactly 7 decimal places", () => {
  for (const { stroops, xlm, label } of VECTORS) {
    it(`${label} has exactly 7 decimal places`, () => {
      const result = stroopsToXlm(stroops);
      const decimals = result.split(".")[1] ?? "";
      expect(decimals.length).toBe(7);
      expect(result).toBe(xlm);
    });
  }
});
