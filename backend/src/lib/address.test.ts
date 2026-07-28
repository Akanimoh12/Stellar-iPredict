import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { isValidAddress, normalizeAddress } from "./address.js";

const VALID_ADDRESS = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

describe("address utilities", () => {
  it("normalizes valid addresses to uppercase", () => {
    const lowercaseAddress = VALID_ADDRESS.toLowerCase();

    expect(normalizeAddress(`  ${lowercaseAddress}  `)).toBe(VALID_ADDRESS);
  });

  it("accepts valid Stellar account addresses", () => {
    expect(isValidAddress(VALID_ADDRESS)).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidAddress("not-a-stellar-address")).toBe(false);
    expect(() => normalizeAddress("not-a-stellar-address")).toThrow(
      "Invalid Stellar address",
    );
  });

  it("rejects non-account StrKey values such as contract addresses", () => {
    expect(isValidAddress(`C${"A".repeat(55)}`)).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidAddress(null)).toBe(false);
    expect(isValidAddress(undefined)).toBe(false);
    expect(isValidAddress(VALID_ADDRESS.length)).toBe(false);
  });
});
