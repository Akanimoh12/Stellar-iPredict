import { describe, it, expect } from "vitest";
import {
  CANONICAL_OUTCOMES,
  normalizeOutcome,
  isCanonicalOutcome,
} from "./oracle.js";

describe("normalizeOutcome (issue #650)", () => {
  it("maps every accepted spelling of YES to the canonical form", () => {
    for (const raw of ["YES", "yes", " Yes ", "y", "Y", "true", "TRUE", "1", true]) {
      expect(normalizeOutcome(raw)).toBe("YES");
    }
  });

  it("maps every accepted spelling of NO to the canonical form", () => {
    for (const raw of ["NO", "no", " No ", "n", "N", "false", "FALSE", "0", false]) {
      expect(normalizeOutcome(raw)).toBe("NO");
    }
  });

  it("rejects anything outside the binary set", () => {
    for (const raw of ["maybe", "YES!", "", "  ", "2", "yesno", "unknown", null, undefined, 1, {}]) {
      expect(normalizeOutcome(raw)).toBeNull();
    }
  });

  it("the boolean and string spellings of the same outcome canonicalize identically", () => {
    expect(normalizeOutcome(true)).toBe(normalizeOutcome("yes"));
    expect(normalizeOutcome(false)).toBe(normalizeOutcome("NO"));
  });

  it("CANONICAL_OUTCOMES is exactly the binary set", () => {
    expect([...CANONICAL_OUTCOMES]).toEqual(["YES", "NO"]);
  });

  it("isCanonicalOutcome only accepts the canonical values", () => {
    expect(isCanonicalOutcome("YES")).toBe(true);
    expect(isCanonicalOutcome("NO")).toBe(true);
    expect(isCanonicalOutcome("yes")).toBe(false);
    expect(isCanonicalOutcome("true")).toBe(false);
    expect(isCanonicalOutcome(true)).toBe(false);
  });
});
