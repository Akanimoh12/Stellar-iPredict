import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { isValidAddress, normalizeAddress } from "../src/lib/address.js";
import {
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
  xlmToStroopsNumber,
} from "../src/lib/amount.js";

describe("address utils", () => {
  const address = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

  it("normalizes a valid address: trims and upper-cases (base32 is case-insensitive)", () => {
    expect(normalizeAddress(`  ${address.toLowerCase()}  `)).toBe(address);
    expect(normalizeAddress(address)).toBe(address);
    expect(isValidAddress(` ${address.toLowerCase()} `)).toBe(true);
  });

  it("rejects malformed strings", () => {
    for (const bad of ["", "   ", "not-an-address", address.slice(0, -1), `${address}A`]) {
      expect(isValidAddress(bad)).toBe(false);
      expect(() => normalizeAddress(bad)).toThrow("Invalid Stellar address");
    }
  });

  it("rejects a muxed (M...) / contract (C...) / secret (S...) key as an account address", () => {
    const secret = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();
    expect(isValidAddress(secret)).toBe(false);
    expect(() => normalizeAddress(secret)).toThrow("Invalid Stellar address");
  });

  it("rejects non-string values without throwing from the guard", () => {
    for (const bad of [null, undefined, 42, {}, [], true, Symbol("x")]) {
      expect(isValidAddress(bad as unknown)).toBe(false);
    }
    expect(() => normalizeAddress(null as unknown as string)).toThrow(TypeError);
    expect(() => normalizeAddress(undefined as unknown as string)).toThrow(
      "Invalid Stellar address",
    );
  });
});

describe("amount utils (stroops <-> XLM)", () => {
  it("exposes the 7-decimal scale", () => {
    expect(STROOPS_PER_XLM).toBe(10_000_000);
  });

  describe("stroopsToXlm", () => {
    it("formats with a fixed 7-decimal fraction", () => {
      expect(stroopsToXlm(0)).toBe("0.0000000");
      expect(stroopsToXlm(1)).toBe("0.0000001");
      expect(stroopsToXlm(10_000_000)).toBe("1.0000000");
      expect(stroopsToXlm(10_000_001)).toBe("1.0000001");
      expect(stroopsToXlm(999_999_999n)).toBe("99.9999999");
    });

    it("keeps full precision for values past Number.MAX_SAFE_INTEGER", () => {
      expect(stroopsToXlm("12345678901234567890")).toBe("1234567890123.4567890");
      expect(stroopsToXlm(123456789012345678901234567890n)).toBe(
        "12345678901234567890123.4567890",
      );
    });

    it("rejects negatives and non-integers", () => {
      expect(() => stroopsToXlm(-1)).toThrow(RangeError);
      expect(() => stroopsToXlm(-1n)).toThrow("stroops must be non-negative");
      expect(() => stroopsToXlm(1.5)).toThrow(RangeError); // not a safe integer
      expect(() => stroopsToXlm("1.5")).toThrow(TypeError);
      expect(() => stroopsToXlm("abc")).toThrow(TypeError);
      expect(() => stroopsToXlm("-5")).toThrow(TypeError);
      expect(() => stroopsToXlm(Number.MAX_SAFE_INTEGER + 2)).toThrow(
        "stroops must be a safe integer",
      );
    });
  });

  describe("xlmToStroops", () => {
    it("converts exactly, with no floating-point drift", () => {
      expect(xlmToStroops("0")).toBe(0n);
      expect(xlmToStroops("1")).toBe(10_000_000n);
      expect(xlmToStroops(0.0000001)).toBe(1n);
      expect(xlmToStroops(1.5)).toBe(15_000_000n);
      expect(xlmToStroops("1.1234567")).toBe(11_234_567n);
      expect(xlmToStroops("1234567890123.4567890")).toBe(12_345_678_901_234_567_890n);
      expect(xlmToStroops(42n)).toBe(420_000_000n);
    });

    it("rejects more than 7 decimal places rather than rounding", () => {
      expect(() => xlmToStroops("1.00000001")).toThrow(
        "xlm must be a non-negative decimal with at most 7 decimal places",
      );
      expect(() => xlmToStroops(1.00000001)).toThrow(
        "xlm must be a non-negative decimal with at most 7 decimal places",
      );
    });

    it("rejects non-numeric, negative and non-finite inputs", () => {
      for (const bad of ["abc", "-1", "1.2.3", "", "  1  ", "1e3", "NaN"]) {
        expect(() => xlmToStroops(bad)).toThrow(TypeError);
      }
      expect(() => xlmToStroops(Number.NaN)).toThrow(TypeError);
      expect(() => xlmToStroops(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => xlmToStroops(1e21)).toThrow(TypeError);
    });
  });

  describe("xlmToStroopsNumber", () => {
    it("returns a JS number when the result is safe", () => {
      expect(xlmToStroopsNumber("1.5")).toBe(15_000_000);
      expect(xlmToStroopsNumber(0)).toBe(0);
    });

    it("throws instead of returning a lossy number above MAX_SAFE_INTEGER", () => {
      expect(() => xlmToStroopsNumber("900719925474.0995800")).toThrow(RangeError);
      expect(() => xlmToStroopsNumber("900719925474.0995800")).toThrow(
        "stroop amount exceeds Number.MAX_SAFE_INTEGER",
      );
    });
  });

  it("round-trips stroops -> XLM -> stroops", () => {
    for (const s of [0n, 1n, 10_000_000n, 123_456_789n, 999_999_999_999_999_999n]) {
      expect(xlmToStroops(stroopsToXlm(s))).toBe(s);
    }
  });
});
