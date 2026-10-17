import { describe, expect, it, vi } from "vitest";
import {
  assessQuote,
  applyConfidenceCeiling,
  DEFAULT_FRESHNESS_POLICY,
  extractTimestampMs,
  freshnessPolicyFromEnv,
  isNotFresh,
  resolveFreshnessPolicy,
  StalenessTracker,
  StaleQuoteError,
} from "../src/adapters/freshness.js";
import {
  recordQuoteStatus,
  resetStalenessRegistry,
  setStalenessTracker,
  staleAdapterReports,
  staleDataAlerts,
} from "../src/adapters/stalenessRegistry.js";

const NOW = Date.parse("2026-04-01T12:00:00.000Z");

describe("extractTimestampMs", () => {
  it("reads epoch milliseconds and epoch seconds into a common unit", () => {
    const seconds = Math.floor(NOW / 1000);
    expect(extractTimestampMs({ closeTime: NOW }, ["closeTime"], NOW)).toBe(NOW);
    expect(extractTimestampMs({ last_updated_timestamp: seconds }, ["last_updated_timestamp"], NOW)).toBe(NOW - (NOW % 1000));
  });

  it("reads ISO-8601 and numeric strings", () => {
    expect(extractTimestampMs({ last_updated: "2026-04-01T12:00:00.000Z" }, ["last_updated"], NOW)).toBe(NOW);
    expect(extractTimestampMs({ last_updated: " 2026-04-01T12:00:00.000Z " }, ["last_updated"], NOW)).toBe(NOW);
    expect(extractTimestampMs({ t: `${NOW}` }, ["t"], NOW)).toBe(NOW);
  });

  it("falls through to the next key when the first is absent or unusable", () => {
    const seconds = Math.floor(NOW / 1000);
    expect(extractTimestampMs({ last_updated_timestamp: seconds }, ["missing", "last_updated_timestamp"], NOW)).toBe(
      NOW - (NOW % 1000),
    );
    expect(extractTimestampMs({ closeTime: "not-a-date", openTime: seconds }, ["closeTime", "openTime"], NOW)).toBe(
      NOW - (NOW % 1000),
    );
  });

  it("returns undefined when the provider supplies no usable timestamp", () => {
    expect(extractTimestampMs({}, ["closeTime"], NOW)).toBeUndefined();
    expect(extractTimestampMs({ closeTime: null }, ["closeTime"], NOW)).toBeUndefined();
    expect(extractTimestampMs({ closeTime: "" }, ["closeTime"], NOW)).toBeUndefined();
    expect(extractTimestampMs({ closeTime: "garbage" }, ["closeTime"], NOW)).toBeUndefined();
    expect(extractTimestampMs(null, ["closeTime"], NOW)).toBeUndefined();
  });

  it("rejects a timestamp far in the future rather than reading it as very fresh", () => {
    // A provider with a broken clock must not produce a negative age, which
    // would pass every freshness check.
    expect(extractTimestampMs({ closeTime: NOW + 3_600_000 }, ["closeTime"], NOW)).toBeUndefined();
    // ...but a small clock skew between oracle and provider is tolerated.
    expect(extractTimestampMs({ closeTime: NOW + 30_000 }, ["closeTime"], NOW)).toBe(NOW + 30_000);
  });
});

describe("resolveFreshnessPolicy", () => {
  it("keeps a downweight window even when only a hard bound is configured", () => {
    // Otherwise the soft bound would collapse onto maxAgeMs, the window would
    // be empty, and a stale quote would be rejected instead of reviewed.
    const policy = resolveFreshnessPolicy({ maxAgeMs: 10_000 });
    expect(policy.staleAfterMs).toBe(10_000);
    expect(resolveFreshnessPolicy().staleAfterMs).toBe(DEFAULT_FRESHNESS_POLICY.staleAfterMs);
    expect(resolveFreshnessPolicy({ maxAgeMs: 600_000 }).staleAfterMs).toBe(
      DEFAULT_FRESHNESS_POLICY.staleAfterMs,
    );
  });

  it("never lets the soft bound exceed the hard bound", () => {
    const policy = resolveFreshnessPolicy({ maxAgeMs: 10_000, staleAfterMs: 60_000 });
    expect(policy.staleAfterMs).toBe(10_000);
  });

  it("rejects nonsensical bounds rather than silently falling back", () => {
    expect(() => resolveFreshnessPolicy({ maxAgeMs: 0 })).toThrow(RangeError);
    expect(() => resolveFreshnessPolicy({ maxAgeMs: -1 })).toThrow(RangeError);
    expect(() => resolveFreshnessPolicy({ maxAgeMs: Number.NaN })).toThrow(RangeError);
    expect(() => resolveFreshnessPolicy({ staleConfidence: 1.5 })).toThrow(RangeError);
    expect(() => resolveFreshnessPolicy({ untimestampedConfidence: -0.1 })).toThrow(RangeError);
  });
});

describe("assessQuote", () => {
  const policy = resolveFreshnessPolicy({ maxAgeMs: 60_000, staleAfterMs: 15_000 });

  it("marks a quote within the soft bound fresh", () => {
    const result = assessQuote(NOW - 5_000, policy, NOW);
    expect(result.status).toBe("fresh");
    expect(result.ageMs).toBe(5_000);
    expect(result.confidenceCeiling).toBe(1);
  });

  it("marks a quote past the soft bound stale and caps its confidence", () => {
    const result = assessQuote(NOW - 30_000, policy, NOW);
    expect(result.status).toBe("stale");
    expect(result.ageMs).toBe(30_000);
    expect(result.confidenceCeiling).toBe(policy.staleConfidence);
    expect(result.confidenceCeiling).toBeLessThan(DEFAULT_FRESHNESS_POLICY.staleConfidence + 1);
  });

  it("marks a quote past the hard bound expired and caps confidence at zero", () => {
    const result = assessQuote(NOW - 120_000, policy, NOW);
    expect(result.status).toBe("expired");
    expect(result.confidenceCeiling).toBe(0);
  });

  it("reports a quote with no timestamp as untimestamped, not as fresh", () => {
    // The whole point: a fresh HTTP response carrying a cached price looks
    // identical to a live one unless the provider stamps it.
    const result = assessQuote(undefined, policy, NOW);
    expect(result.status).toBe("untimestamped");
    expect(result.ageMs).toBeNull();
    expect(result.observedAtMs).toBeNull();
    expect(result.confidenceCeiling).toBe(policy.untimestampedConfidence);
  });

  it("treats a 0ms age as distinct from an absent timestamp", () => {
    expect(assessQuote(NOW, policy, NOW).status).toBe("fresh");
    expect(assessQuote(null, policy, NOW).status).toBe("untimestamped");
  });

  it("clamps a negative age from clock skew to zero", () => {
    expect(assessQuote(NOW + 5_000, policy, NOW).ageMs).toBe(0);
  });
});

describe("applyConfidenceCeiling", () => {
  it("leaves a fresh quote untouched and clamps a stale one", () => {
    const policy = resolveFreshnessPolicy({ maxAgeMs: 60_000, staleAfterMs: 15_000, staleConfidence: 0.4 });
    expect(applyConfidenceCeiling(1, assessQuote(NOW, policy, NOW))).toBe(1);
    expect(applyConfidenceCeiling(1, assessQuote(NOW - 30_000, policy, NOW))).toBe(0.4);
  });

  it("keeps the ceiling from ever raising a low base confidence", () => {
    const fresh = assessQuote(NOW, DEFAULT_FRESHNESS_POLICY, NOW);
    expect(applyConfidenceCeiling(0.2, fresh)).toBe(0.2);
  });
});

describe("StaleQuoteError", () => {
  it("carries the numbers an operator needs to diagnose it", () => {
    const error = new StaleQuoteError("binance", { ageMs: 3_600_000, maxAgeMs: 120_000, observedAtMs: NOW });
    expect(error.name).toBe("StaleQuoteError");
    expect(error.source).toBe("binance");
    expect(error.ageMs).toBe(3_600_000);
    expect(error.maxAgeMs).toBe(120_000);
    expect(error.message).toContain("3600.0s old");
    expect(error.message).toContain("120.0s");
  });
});

describe("StalenessTracker", () => {
  it("stays quiet for a single stale observation", () => {
    const tracker = new StalenessTracker({ windowMs: 60_000, minNotFresh: 3, minRatio: 0.5 });
    tracker.record("binance", "stale", NOW);
    expect(tracker.evaluate(NOW)).toEqual([]);
  });

  it("stays quiet when stale observations are a minority of the window", () => {
    const tracker = new StalenessTracker({ windowMs: 60_000, minNotFresh: 3, minRatio: 0.5 });
    // 6 fresh, 2 stale — under the ratio even though the count clears.
    for (let i = 0; i < 6; i++) tracker.record("binance", "fresh", NOW - i * 1_000);
    for (let i = 0; i < 2; i++) tracker.record("binance", "stale", NOW - i * 1_000);
    expect(tracker.evaluate(NOW)).toEqual([]);
  });

  it("reports an adapter that is consistently returning stale data", () => {
    const tracker = new StalenessTracker({ windowMs: 60_000, minNotFresh: 3, minRatio: 0.5 });
    for (let i = 0; i < 4; i++) tracker.record("binance", "stale", NOW - i * 10_000);

    const [report] = tracker.evaluate(NOW);

    expect(report).toBeDefined();
    expect(report!.adapterId).toBe("binance");
    expect(report!.notFresh).toBe(4);
    expect(report!.total).toBe(4);
    expect(report!.ratio).toBe(1);
    expect(report!.worstStatus).toBe("stale");
    expect(report!.windowFullyNotFresh).toBe(true);
    expect(report!.consecutiveNotFreshMs).toBe(30_000);
  });

  it("flags an adapter that never supplies a timestamp", () => {
    const tracker = new StalenessTracker({ windowMs: 60_000, minNotFresh: 3, minRatio: 0.5 });
    for (let i = 0; i < 3; i++) tracker.record("coingecko", "untimestamped", NOW - i * 1_000);

    const [report] = tracker.evaluate(NOW);
    expect(report!.worstStatus).toBe("untimestamped");
  });

  it("orders reports worst-ratio first", () => {
    const tracker = new StalenessTracker({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    // 2 of 4 stale — clears the ratio bar, but not every sample.
    tracker.record("mixed", "fresh", NOW - 1_000);
    tracker.record("mixed", "fresh", NOW - 2_000);
    tracker.record("mixed", "stale", NOW - 3_000);
    tracker.record("mixed", "stale", NOW - 4_000);
    tracker.record("all-bad", "expired", NOW - 1_000);
    tracker.record("all-bad", "expired", NOW - 2_000);

    const reports = tracker.evaluate(NOW);
    expect(reports.map((r) => r.adapterId)).toEqual(["all-bad", "mixed"]);
    expect(reports[0]!.windowFullyNotFresh).toBe(true);
    expect(reports[1]!.windowFullyNotFresh).toBe(false);
  });

  it("reports the same run length regardless of the order samples arrived in", () => {
    const ascending = new StalenessTracker({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    const descending = new StalenessTracker({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    for (let i = 0; i < 4; i++) ascending.record("a", "stale", NOW - i * 10_000);
    for (let i = 3; i >= 0; i--) descending.record("a", "stale", NOW - i * 10_000);

    expect(ascending.evaluate(NOW)[0]!.consecutiveNotFreshMs).toBe(30_000);
    expect(descending.evaluate(NOW)[0]!.consecutiveNotFreshMs).toBe(30_000);
  });

  it("drops observations that fall out of the window", () => {
    const tracker = new StalenessTracker({ windowMs: 10_000, minNotFresh: 2, minRatio: 0.5 });
    tracker.record("binance", "stale", NOW - 120_000);
    tracker.record("binance", "stale", NOW - 119_000);
    expect(tracker.evaluate(NOW)).toEqual([]);
  });

  it("restarts the not-fresh run after a fresh observation", () => {
    const tracker = new StalenessTracker({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    tracker.record("binance", "stale", NOW - 20_000);
    tracker.record("binance", "stale", NOW - 10_000);
    tracker.record("binance", "fresh", NOW - 5_000);
    tracker.record("binance", "stale", NOW - 1_000);

    const [report] = tracker.evaluate(NOW);
    expect(report!.consecutiveNotFreshMs).toBe(1_000);
  });

  it("rejects a nonsensical configuration", () => {
    expect(() => new StalenessTracker({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new StalenessTracker({ minNotFresh: 0 })).toThrow(RangeError);
    expect(() => new StalenessTracker({ minRatio: 0 })).toThrow(RangeError);
    expect(() => new StalenessTracker({ minRatio: 1.5 })).toThrow(RangeError);
  });
});

describe("freshnessPolicyFromEnv", () => {
  it("reads per-adapter bounds from the environment", () => {
    const policy = freshnessPolicyFromEnv("ORACLE_BINANCE", {
      ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS: "5000",
      ORACLE_BINANCE_FRESHNESS_STALE_AFTER_MS: "1000",
      ORACLE_BINANCE_FRESHNESS_STALE_CONFIDENCE: "0.3",
      ORACLE_BINANCE_FRESHNESS_UNTIMESTAMPED_CONFIDENCE: "0.2",
    });
    expect(policy).toEqual({
      maxAgeMs: 5_000,
      staleAfterMs: 1_000,
      staleConfidence: 0.3,
      untimestampedConfidence: 0.2,
    });
  });

  it("keeps the two adapters' configuration independent", () => {
    const env = { ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS: "5000" };
    expect(freshnessPolicyFromEnv("ORACLE_BINANCE", env).maxAgeMs).toBe(5_000);
    expect(freshnessPolicyFromEnv("ORACLE_COINGECKO", env).maxAgeMs).toBe(
      DEFAULT_FRESHNESS_POLICY.maxAgeMs,
    );
  });

  it("treats an empty variable as unset, like the .env files spell it", () => {
    const policy = freshnessPolicyFromEnv("ORACLE_BINANCE", { ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS: "  " });
    expect(policy.maxAgeMs).toBe(DEFAULT_FRESHNESS_POLICY.maxAgeMs);
  });

  it("throws on an unparseable value rather than silently using the default", () => {
    expect(() =>
      freshnessPolicyFromEnv("ORACLE_BINANCE", { ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS: "sixty" }),
    ).toThrow(/must be a number/);
  });

  it("lets constructor options act as the base the environment overrides", () => {
    const policy = freshnessPolicyFromEnv("ORACLE_BINANCE", {}, { maxAgeMs: 9_000 });
    expect(policy.maxAgeMs).toBe(9_000);
  });
});

describe("staleness registry", () => {
  it("records adapter statuses and reports sustained staleness", () => {
    resetStalenessRegistry({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    recordQuoteStatus("binance", "stale", NOW);
    expect(staleAdapterReports(NOW)).toEqual([]);

    recordQuoteStatus("binance", "stale", NOW - 1_000);
    const reports = staleAdapterReports(NOW);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.adapterId).toBe("binance");
  });

  it("turns reports into operator-facing alert payloads", () => {
    resetStalenessRegistry({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    recordQuoteStatus("coinmarketcap", "expired", NOW - 30_000);
    recordQuoteStatus("coinmarketcap", "expired", NOW - 1_000);

    const [alert] = staleDataAlerts(NOW);
    expect(alert!.adapterId).toBe("coinmarketcap");
    expect(alert!.status).toBe("expired");
    expect(alert!.windowFullyNotFresh).toBe(true);
    expect(alert!.message).toContain("coinmarketcap");
    expect(alert!.message).toContain("resolving against downweighted or unverifiable data");
  });

  it("distinguishes an untimestamped provider from a stale one in the alert", () => {
    resetStalenessRegistry({ windowMs: 60_000, minNotFresh: 2, minRatio: 0.5 });
    recordQuoteStatus("coingecko", "untimestamped", NOW - 5_000);
    recordQuoteStatus("coingecko", "untimestamped", NOW - 1_000);

    const [alert] = staleDataAlerts(NOW);
    expect(alert!.status).toBe("untimestamped");
  });

  it("never throws out of recordQuoteStatus, whatever it is handed", () => {
    const broken = {
      record: () => {
        throw new Error("tracker exploded");
      },
      evaluate: () => {
        throw new Error("tracker exploded");
      },
      reset: () => {},
      size: () => 0,
    };
    setStalenessTracker(broken as never);
    expect(() => recordQuoteStatus("binance", "stale", NOW)).not.toThrow();
    expect(staleAdapterReports(NOW)).toEqual([]);
  });
});

describe("isNotFresh", () => {
  it("treats only a timestamped, in-window quote as fresh", () => {
    expect(isNotFresh("fresh")).toBe(false);
    expect(isNotFresh("stale")).toBe(true);
    expect(isNotFresh("expired")).toBe(true);
    expect(isNotFresh("untimestamped")).toBe(true);
  });
});

describe("clock", () => {
  it("does not depend on the process clock for any of the above", () => {
    // Guards against a future refactor reintroducing Date.now() into the
    // comparison paths these tests drive explicitly.
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(0);
    try {
      const policy = resolveFreshnessPolicy({ maxAgeMs: 60_000, staleAfterMs: 15_000 });
      expect(assessQuote(0, policy, NOW).status).toBe("expired");
      expect(assessQuote(NOW, policy, NOW).status).toBe("fresh");
      expect(extractTimestampMs({ closeTime: NOW }, ["closeTime"], NOW)).toBe(NOW);
    } finally {
      spy.mockRestore();
    }
  });
});
