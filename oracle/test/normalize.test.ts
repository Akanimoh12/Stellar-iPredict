import { describe, expect, it } from "vitest";

import { resolveFreshnessPolicy } from "../src/adapters/freshness.js";
import {
  normalizeCrypto,
  normalizeCryptoQuote,
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

describe("crypto freshness gate (issue #744)", () => {
  const NOW = Date.parse("2026-04-01T12:00:00.000Z");
  const POLICY = resolveFreshnessPolicy({ maxAgeMs: 60_000, staleAfterMs: 15_000 });

  it("leaves a quote alone when no policy is supplied", () => {
    // Opt-in, and deliberately so: a caller with no policy is not silently
    // given the defaults, because that would change the confidence of every
    // existing caller as a side effect of adding the field.
    const far = normalizeCrypto({ price: 100_000, threshold: 50_000, comparator: "gte", observedAtMs: 0 });
    expect(far.confidence).toBe(1);
  });

  it("does not cap a fresh, timestamped quote", () => {
    const result = normalizeCrypto({
      price: 100_000,
      threshold: 50_000,
      comparator: "gte",
      observedAtMs: NOW - 1_000,
      freshness: POLICY,
      now: NOW,
    });
    expect(result).toEqual({ outcome: true, confidence: 1 });
  });

  it("caps a stale quote below the resolution floor", () => {
    const result = normalizeCrypto({
      price: 100_000,
      threshold: 50_000,
      comparator: "gte",
      observedAtMs: NOW - 30_000,
      freshness: POLICY,
      now: NOW,
    });
    // 0.5 is below DEFAULT_CATEGORY_CONFIG.crypto.minConfidence (0.7), so the
    // resolution is held for review rather than settled.
    expect(result.confidence).toBe(0.5);
    // The outcome is still answered; freshness governs confidence, not the answer.
    expect(result.outcome).toBe(true);
  });

  it("caps a quote with no timestamp at all", () => {
    for (const observedAtMs of [undefined, null]) {
      const result = normalizeCrypto({
        price: 100_000,
        threshold: 50_000,
        comparator: "gte",
        observedAtMs,
        freshness: POLICY,
        now: NOW,
      });
      expect(result.confidence).toBe(0.5);
    }
  });

  it("keeps a marginal fresh quote marginal — the cap only ever lowers", () => {
    const result = normalizeCrypto({
      price: 50_100,
      threshold: 50_000,
      comparator: "gte",
      observedAtMs: NOW,
      freshness: POLICY,
      now: NOW,
    });
    // 0.2% from the boundary: the distance score is ~0.52, and the ceiling
    // must not lift it to 1.
    expect(result.confidence).toBeLessThan(0.55);
  });

  it("leaves non-crypto categories untouched", () => {
    expect(normalizeOutcome({ category: "sports", final: true, outcome: true })).toEqual({
      outcome: true,
      confidence: 1,
    });
    expect(normalizeOutcome({ category: "politics", outcome: true, consensusFraction: 0.8 })).toEqual({
      outcome: true,
      confidence: 0.8,
    });
  });
});

describe("normalizeCryptoQuote", () => {
  const NOW = Date.parse("2026-04-01T12:00:00.000Z");
  const POLICY = resolveFreshnessPolicy({ maxAgeMs: 60_000, staleAfterMs: 15_000 });

  it("keeps a base confidence of 1 for a fresh quote", () => {
    expect(
      normalizeCryptoQuote({
        price: 50_100,
        threshold: 50_000,
        comparator: "gte",
        observedAtMs: NOW - 1_000,
        freshness: POLICY,
        now: NOW,
      }),
    ).toEqual({ outcome: true, confidence: 1 });
  });

  it("caps a stale quote without re-scoring it on distance", () => {
    // A price 0.2% from the boundary still reports the capped 0.5, not the
    // distance score: the adapter's base confidence is 1, and freshness is the
    // only thing reducing it.
    const result = normalizeCryptoQuote({
      price: 50_100,
      threshold: 50_000,
      comparator: "gte",
      observedAtMs: NOW - 30_000,
      freshness: POLICY,
      now: NOW,
    });
    expect(result).toEqual({ outcome: true, confidence: 0.5 });
  });

  it("honours a custom base confidence, clamped to [0, 1]", () => {
    expect(
      normalizeCryptoQuote({
        price: 1,
        threshold: 1,
        comparator: "gte",
        baseConfidence: 2,
      }).confidence,
    ).toBe(1);
    expect(
      normalizeCryptoQuote({
        price: 1,
        threshold: 1,
        comparator: "gte",
        baseConfidence: -1,
      }).confidence,
    ).toBe(0);
  });

  it("reports no usable data for a non-finite price", () => {
    for (const price of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        normalizeCryptoQuote({ price, threshold: 1, comparator: "gte", freshness: POLICY, now: NOW }),
      ).toEqual({ outcome: false, confidence: 0 });
    }
  });

  it("computes the outcome from the number the provider sent, whatever the cap", () => {
    expect(
      normalizeCryptoQuote({
        price: 49_000,
        threshold: 50_000,
        comparator: "gte",
        observedAtMs: NOW - 30_000,
        freshness: POLICY,
        now: NOW,
      }),
    ).toEqual({ outcome: false, confidence: 0.5 });

    expect(
      normalizeCryptoQuote({
        price: 49_000,
        threshold: 50_000,
        comparator: "lte",
        observedAtMs: NOW - 30_000,
        freshness: POLICY,
        now: NOW,
      }),
    ).toEqual({ outcome: true, confidence: 0.5 });
  });
});
