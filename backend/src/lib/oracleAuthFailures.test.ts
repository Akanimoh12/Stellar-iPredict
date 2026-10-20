import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ORACLE_AUTH_FAILURE_REASONS,
  assessOracleAuthFailureSpike,
  configureOracleAuthFailureThresholds,
  getOracleAuthFailureSnapshot,
  getOracleAuthFailureThresholds,
  recordOracleAuthAttempt,
  recordOracleAuthFailure,
  resetOracleAuthFailures,
  serializeOracleAuthFailureMetrics,
  type OracleAuthFailureSnapshot,
} from "./oracleAuthFailures.js";

/** A snapshot with everything at zero, so a case only states what it varies. */
function snapshot(
  overrides: Partial<OracleAuthFailureSnapshot> = {},
): OracleAuthFailureSnapshot {
  return {
    totalAttempts: 0,
    totalFailures: 0,
    totalByReason: {
      missing_header: 0,
      invalid_key: 0,
      provider_mismatch: 0,
      not_configured: 0,
    },
    windowMs: 300_000,
    windowAttempts: 0,
    windowFailures: 0,
    windowByReason: {
      missing_header: 0,
      invalid_key: 0,
      provider_mismatch: 0,
      not_configured: 0,
    },
    windowDistinctSources: 0,
    sourceOverflow: false,
    topSourceShare: 0,
    lastFailureAt: null,
    ...overrides,
  };
}

const TEST_WINDOW_MS = 60_000;
const TEST_THRESHOLDS = {
  windowMs: TEST_WINDOW_MS,
  minFailures: 3,
  distributedSourceThreshold: 3,
  cooldownMs: 1_000,
  maxTrackedSources: 10,
};

describe("oracle auth failure telemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    configureOracleAuthFailureThresholds(TEST_THRESHOLDS);
    resetOracleAuthFailures();
  });

  afterEach(() => {
    resetOracleAuthFailures();
    configureOracleAuthFailureThresholds(TEST_THRESHOLDS);
    vi.useRealTimers();
  });

  it("counts attempts separately from failures", () => {
    // The route records one attempt per request, accepted or rejected, and a
    // failure on top of that — so attempts are the denominator of the rate.
    recordOracleAuthAttempt();
    recordOracleAuthAttempt();
    recordOracleAuthAttempt();
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.totalAttempts).toBe(3);
    expect(snap.totalFailures).toBe(1);
    expect(snap.windowAttempts).toBe(3);
    expect(snap.windowFailures).toBe(1);
  });

  it("counts failures by reason", () => {
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.2" });
    recordOracleAuthFailure({ reason: "provider_mismatch", source: "10.0.0.3" });

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.totalByReason.invalid_key).toBe(2);
    expect(snap.totalByReason.provider_mismatch).toBe(1);
    expect(snap.totalByReason.missing_header).toBe(0);
    expect(snap.totalFailures).toBe(3);
  });

  it("counts failures by distinct source", () => {
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.2" });

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.windowDistinctSources).toBe(2);
    expect(snap.topSource).toBe("10.0.0.1");
    expect(snap.topSourceShare).toBeCloseTo(2 / 3);
  });

  it("falls back to a placeholder source when none is supplied", () => {
    recordOracleAuthFailure({ reason: "missing_header" });
    expect(getOracleAuthFailureSnapshot().topSource).toBe("unknown");
  });

  it("bounds the tracked source set and flags overflow", () => {
    configureOracleAuthFailureThresholds({ maxTrackedSources: 2 });
    resetOracleAuthFailures();

    recordOracleAuthFailure({ reason: "invalid_key", source: "a" });
    recordOracleAuthFailure({ reason: "invalid_key", source: "b" });
    recordOracleAuthFailure({ reason: "invalid_key", source: "c" });

    const snap = getOracleAuthFailureSnapshot();
    // The map must not grow past the cap; "many" is all the classifier needs.
    expect(snap.windowDistinctSources).toBe(2);
    expect(snap.sourceOverflow).toBe(true);
  });

  it("ages failures out of the window", () => {
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    expect(getOracleAuthFailureSnapshot().windowFailures).toBe(1);

    vi.advanceTimersByTime(TEST_WINDOW_MS + 1_000);

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.windowFailures).toBe(0);
    // Lifetime counters are not windowed.
    expect(snap.totalFailures).toBe(1);
  });

  it("categorises a concentrated spike as a misconfigured provider", () => {
    for (let i = 0; i < 4; i++) {
      recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.9" });
    }

    const assessment = assessOracleAuthFailureSpike(
      getOracleAuthFailureSnapshot(),
      TEST_THRESHOLDS,
    );
    expect(assessment.pattern).toBe("misconfigured_provider");
    expect(assessment.level).toBe("warning");
  });

  it("categorises invalid keys from many origins as distributed guessing", () => {
    for (let i = 0; i < 4; i++) {
      recordOracleAuthFailure({ reason: "invalid_key", source: `198.51.100.${i}` });
    }

    const assessment = assessOracleAuthFailureSpike(
      getOracleAuthFailureSnapshot(),
      TEST_THRESHOLDS,
    );
    expect(assessment.pattern).toBe("distributed_guessing");
    expect(assessment.level).toBe("critical");
    expect(assessment.distinctSources).toBe(4);
  });

  it("never calls a valid-key or missing-header spike 'guessing'", () => {
    const byProviderMismatch = snapshot({
      windowFailures: 10,
      windowAttempts: 10,
      windowDistinctSources: 9,
      windowByReason: {
        missing_header: 0,
        invalid_key: 0,
        provider_mismatch: 10,
        not_configured: 0,
      },
    });
    expect(
      assessOracleAuthFailureSpike(byProviderMismatch, TEST_THRESHOLDS).pattern,
    ).toBe("misconfigured_provider");

    const byMissingHeader = snapshot({
      windowFailures: 10,
      windowAttempts: 10,
      windowDistinctSources: 9,
      windowByReason: {
        missing_header: 10,
        invalid_key: 0,
        provider_mismatch: 0,
        not_configured: 0,
      },
    });
    expect(
      assessOracleAuthFailureSpike(byMissingHeader, TEST_THRESHOLDS).pattern,
    ).toBe("misconfigured_provider");
  });

  it("stays quiet below the baseline", () => {
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    const assessment = assessOracleAuthFailureSpike(
      getOracleAuthFailureSnapshot(),
      TEST_THRESHOLDS,
    );
    expect(assessment.level).toBe("ok");
    expect(assessment.pattern).toBe("none");
    expect(assessment.shouldAlert).toBe(false);
  });

  it("treats source overflow as distributed", () => {
    const overflowed = snapshot({
      windowFailures: 10,
      windowAttempts: 10,
      windowDistinctSources: 2,
      sourceOverflow: true,
      windowByReason: {
        missing_header: 0,
        invalid_key: 10,
        provider_mismatch: 0,
        not_configured: 0,
      },
    });
    expect(
      assessOracleAuthFailureSpike(overflowed, TEST_THRESHOLDS).pattern,
    ).toBe("distributed_guessing");
  });

  it("reports the failure rate against attempts", () => {
    for (let i = 0; i < 2; i++) recordOracleAuthAttempt();
    for (let i = 0; i < 2; i++) {
      recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    }

    const assessment = assessOracleAuthFailureSpike(
      getOracleAuthFailureSnapshot(),
      TEST_THRESHOLDS,
    );
    expect(assessment.failureRate).toBeCloseTo(1);
  });

  it("edge-triggers the alert once, then re-arms after the cooldown", () => {
    const fire = () =>
      recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });

    expect(fire().shouldAlert).toBe(false);
    expect(fire().shouldAlert).toBe(false);
    // Third failure crosses the baseline: this is the one that alerts.
    expect(fire().shouldAlert).toBe(true);
    // The next failure is inside the cooldown and must not re-alert.
    expect(fire().shouldAlert).toBe(false);

    vi.advanceTimersByTime(TEST_THRESHOLDS.cooldownMs + 1);
    expect(fire().shouldAlert).toBe(true);
  });

  it("re-arms immediately when the pattern changes", () => {
    const fire = (source: string) =>
      recordOracleAuthFailure({ reason: "invalid_key", source });

    fire("10.0.0.1");
    fire("10.0.0.1");
    expect(fire("10.0.0.1").shouldAlert).toBe(true);

    vi.advanceTimersByTime(100);
    // Two more origins push the cluster to distributed: a different incident,
    // so the cooldown does not apply.
    fire("10.0.0.2");
    expect(fire("10.0.0.3").shouldAlert).toBe(true);
  });

  it("exposes the configured thresholds", () => {
    expect(getOracleAuthFailureThresholds().minFailures).toBe(3);
  });

  it("serialises every reason and the gauges even before any failure", () => {
    const output = serializeOracleAuthFailureMetrics();

    expect(output).toContain("oracle_auth_attempts_total 0");
    for (const reason of ORACLE_AUTH_FAILURE_REASONS) {
      expect(output).toContain(`oracle_auth_failures_total{reason="${reason}"} 0`);
    }
    expect(output).toContain("oracle_auth_failures_window 0");
    expect(output).toContain("oracle_auth_failure_sources_distinct 0");
    expect(output).toContain("oracle_auth_failure_rate 0");
  });

  it("serialises live counts after failures", () => {
    recordOracleAuthAttempt();
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    recordOracleAuthFailure({ reason: "provider_mismatch", source: "10.0.0.2" });

    const output = serializeOracleAuthFailureMetrics();
    expect(output).toContain("oracle_auth_attempts_total 1");
    expect(output).toContain('oracle_auth_failures_total{reason="invalid_key"} 1');
    expect(output).toContain('oracle_auth_failures_total{reason="provider_mismatch"} 1');
    expect(output).toContain("oracle_auth_failures_window 2");
    expect(output).toContain("oracle_auth_failure_sources_distinct 2");
  });

  it("clears all state on reset", () => {
    recordOracleAuthAttempt();
    recordOracleAuthFailure({ reason: "invalid_key", source: "10.0.0.1" });
    resetOracleAuthFailures();

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.totalAttempts).toBe(0);
    expect(snap.totalFailures).toBe(0);
    expect(snap.windowDistinctSources).toBe(0);
    expect(snap.sourceOverflow).toBe(false);
    expect(snap.lastFailureAt).toBeNull();
  });
});
