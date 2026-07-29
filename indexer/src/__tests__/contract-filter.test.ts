import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseContractIds,
  validateContractId,
  loadContractAllowlist,
  makeContractFilter,
} from "../contract-filter.js";

const VALID_ID_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_ID_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("parseContractIds", () => {
  it("splits a comma-separated string into trimmed IDs", () => {
    expect(parseContractIds(`${VALID_ID_A}, ${VALID_ID_B}`)).toEqual([
      VALID_ID_A,
      VALID_ID_B,
    ]);
  });

  it("filters out empty segments from extra commas", () => {
    expect(parseContractIds(`,${VALID_ID_A},,`)).toEqual([VALID_ID_A]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseContractIds("")).toEqual([]);
  });
});

describe("validateContractId", () => {
  it("accepts a well-formed Stellar contract Strkey", () => {
    expect(validateContractId(VALID_ID_A)).toBe(true);
  });

  it("rejects an ID that is too short", () => {
    expect(validateContractId("CAAAAAAA")).toBe(false);
  });

  it("rejects an ID that does not start with C", () => {
    // G-prefix is a public key, not a contract
    expect(validateContractId("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });

  it("rejects an ID with invalid base-32 characters (0, 1, 8, 9)", () => {
    const withZero = "C0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(validateContractId(withZero)).toBe(false);
  });
});

describe("loadContractAllowlist", () => {
  const originalEnv = process.env.CONTRACT_IDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CONTRACT_IDS;
    } else {
      process.env.CONTRACT_IDS = originalEnv;
    }
  });

  it("returns validated IDs from CONTRACT_IDS env var", () => {
    process.env.CONTRACT_IDS = VALID_ID_A;
    expect(loadContractAllowlist()).toEqual([VALID_ID_A]);
  });

  it("accepts multiple IDs from CONTRACT_IDS env var", () => {
    process.env.CONTRACT_IDS = `${VALID_ID_A},${VALID_ID_B}`;
    expect(loadContractAllowlist()).toEqual([VALID_ID_A, VALID_ID_B]);
  });

  it("accepts IDs passed via config.raw (ignores env)", () => {
    process.env.CONTRACT_IDS = "not-used";
    expect(loadContractAllowlist({ raw: VALID_ID_B })).toEqual([VALID_ID_B]);
  });

  it("throws when CONTRACT_IDS is empty", () => {
    process.env.CONTRACT_IDS = "  ";
    expect(() => loadContractAllowlist()).toThrow(/CONTRACT_IDS/);
  });

  it("throws when CONTRACT_IDS is not set", () => {
    delete process.env.CONTRACT_IDS;
    expect(() => loadContractAllowlist()).toThrow(/CONTRACT_IDS/);
  });

  it("throws when any ID is invalid", () => {
    process.env.CONTRACT_IDS = `${VALID_ID_A},bad-id`;
    expect(() => loadContractAllowlist()).toThrow(/bad-id/);
  });
});

describe("makeContractFilter", () => {
  it("returns true for IDs in the allowlist", () => {
    const filter = makeContractFilter([VALID_ID_A]);
    expect(filter(VALID_ID_A)).toBe(true);
  });

  it("returns false for IDs not in the allowlist", () => {
    const filter = makeContractFilter([VALID_ID_A]);
    expect(filter(VALID_ID_B)).toBe(false);
  });

  it("handles an empty allowlist (blocks everything)", () => {
    const filter = makeContractFilter([]);
    expect(filter(VALID_ID_A)).toBe(false);
  });
});
