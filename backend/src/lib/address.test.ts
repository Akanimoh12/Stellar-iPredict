import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { isValidAddress, normalizeAddress } from "./address.js";

describe("address utilities", () => {
  it("normalizes valid addresses to uppercase and trims whitespace", () => {
    const address = Keypair.random().publicKey();

    expect(normalizeAddress(`  ${address.toLowerCase()}  `)).toBe(address);
  });

  it("rejects invalid Stellar addresses", () => {
    expect(() => normalizeAddress("not-a-stellar-address")).toThrow(
      "Invalid Stellar address",
    );
    expect(isValidAddress("not-a-stellar-address")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidAddress(null)).toBe(false);
    expect(isValidAddress(undefined)).toBe(false);
    expect(isValidAddress(42)).toBe(false);
    expect(() => normalizeAddress(null as unknown as string)).toThrow(
      "Invalid Stellar address",
    );
  });
});
