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
    for (const bad of [null, undefined, 42, {}, [], true, Symbol("x")]) {
      expect(isValidAddress(bad as unknown)).toBe(false);
    }
    expect(() => normalizeAddress(null as unknown as string)).toThrow(TypeError);
    expect(() => normalizeAddress(undefined as unknown as string)).toThrow(
      "Invalid Stellar address",
    );
  });

  it("rejects a muxed (M...) / contract (C...) / secret (S...) key as an account address", () => {
    const secret = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();
    expect(isValidAddress(secret)).toBe(false);
    expect(() => normalizeAddress(secret)).toThrow("Invalid Stellar address");
  });
});
