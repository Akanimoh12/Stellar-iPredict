import { describe, expect, it } from "vitest";

import {
  normalizeCrypto,
  normalizePolitics,
  normalizeScience,
  normalizeSports,
  normalizeOutcome,
} from "../src/adapters/normalize.js";

// ---------------------------------------------------------------------------
// normalizeCrypto
// ---------------------------------------------------------------------------

describe("normalizeCrypto", () => {
  it("gte comparator: price above threshold → outcome true", () => {
    const result = normalizeCrypto({ price: 70_000, threshold: 60_000, comparator: "gte" });
    expect(result.outcome).toBe(true);
  });

  it("gte comparator: price below threshold → outcome false", () => {
    const result = normalizeCrypto({ price: 50_000, threshold: 60_000, comparator: "gte" });
    expect(result.outcome).toBe(false);
  });

  it("lte comparator: price below threshold → outcome true", () => {
    const result = normalizeCrypto({ price: 50_000, threshold: 60_000, comparator: "lte" });
    expect(result.outcome).toBe(true);
  });

  it("lte comparator: price above threshold → outcome false", () => {
    const result = normalizeCrypto({ price: 70_000, threshold: 60_000, comparator: "lte" });
    expect(result.outcome).toBe(false);
  });

  it("price exactly at threshold → outcome true for gte, confidence = 0.5", () => {
    const result = normalizeCrypto({ price: 60_000, threshold: 60_000, comparator: "gte" });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it("confidence is 1.0 when price is ≥ 5% away from threshold", () => {
    // 60_000 * 0.05 = 3000; price 63_000 → exactly at full confidence boundary
    const result = normalizeCrypto({ price: 63_000, threshold: 60_000, comparator: "gte" });
    expect(result.confidence).toBeCloseTo(1.0);
  });

  it("confidence is in [0.5, 1.0]", () => {
    for (const price of [59_000, 60_000, 61_000, 63_000, 70_000]) {
      const { confidence } = normalizeCrypto({ price, threshold: 60_000, comparator: "gte" });
      expect(confidence).toBeGreaterThanOrEqual(0.5);
      expect(confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("returns confidence 0 for non-finite inputs", () => {
    expect(normalizeCrypto({ price: NaN, threshold: 60_000, comparator: "gte" }).confidence).toBe(0);
    expect(normalizeCrypto({ price: 60_000, threshold: 0, comparator: "gte" }).confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeSports
// ---------------------------------------------------------------------------

describe("normalizeSports", () => {
  it("final result → confidence 1.0", () => {
    const result = normalizeSports({ final: true, outcome: true });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("provisional result → confidence 0.7", () => {
    const result = normalizeSports({ final: false, outcome: false });
    expect(result.outcome).toBe(false);
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it("sourceConfidence multiplies base confidence for final result", () => {
    const result = normalizeSports({ final: true, outcome: true, sourceConfidence: 0.9 });
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("sourceConfidence multiplies base confidence for provisional result", () => {
    const result = normalizeSports({ final: false, outcome: true, sourceConfidence: 0.8 });
    expect(result.confidence).toBeCloseTo(0.7 * 0.8);
  });

  it("confidence is clamped to [0, 1]", () => {
    const result = normalizeSports({ final: true, outcome: true, sourceConfidence: 2.0 });
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// normalizePolitics
// ---------------------------------------------------------------------------

describe("normalizePolitics", () => {
  it("full consensus → confidence 1.0", () => {
    const result = normalizePolitics({ outcome: true, consensusFraction: 1.0 });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("zero consensus → confidence 0.0", () => {
    const result = normalizePolitics({ outcome: false, consensusFraction: 0.0 });
    expect(result.confidence).toBe(0.0);
  });

  it("0.5 consensus → confidence 0.5 (tie)", () => {
    const result = normalizePolitics({ outcome: true, consensusFraction: 0.5 });
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it("clamps out-of-range values", () => {
    expect(normalizePolitics({ outcome: true, consensusFraction: 1.5 }).confidence).toBe(1.0);
    expect(normalizePolitics({ outcome: false, consensusFraction: -0.1 }).confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// normalizeScience
// ---------------------------------------------------------------------------

describe("normalizeScience", () => {
  it("passes through confidence in [0, 1]", () => {
    const result = normalizeScience({ outcome: true, confidence: 0.85 });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it("clamps confidence above 1 to 1", () => {
    expect(normalizeScience({ outcome: false, confidence: 1.5 }).confidence).toBe(1.0);
  });

  it("clamps confidence below 0 to 0", () => {
    expect(normalizeScience({ outcome: true, confidence: -0.1 }).confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// normalizeOutcome — unified dispatcher
// ---------------------------------------------------------------------------

describe("normalizeOutcome", () => {
  it("routes crypto payload", () => {
    const result = normalizeOutcome({
      category: "crypto",
      price: 65_000,
      threshold: 60_000,
      comparator: "gte",
    });
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("routes sports payload", () => {
    const result = normalizeOutcome({ category: "sports", final: true, outcome: false });
    expect(result.outcome).toBe(false);
    expect(result.confidence).toBe(1.0);
  });

  it("routes politics payload", () => {
    const result = normalizeOutcome({ category: "politics", outcome: true, consensusFraction: 0.8 });
    expect(result.confidence).toBeCloseTo(0.8);
  });

  it("routes science payload", () => {
    const result = normalizeOutcome({ category: "science", outcome: true, confidence: 0.9 });
    expect(result.confidence).toBeCloseTo(0.9);
  });
});
