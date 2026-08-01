import { describe, expect, it, vi } from "vitest";
import { resolveMarketOnChain, type OnChainSubmitter, type ResolveMarketResult } from "../src/submitter/resolveMarket.js";
import { AggregatorMetrics, ORACLE_RESOLUTION_LAG_H_METRIC } from "../src/aggregator/metrics.js";

function makeDeps(overrides: {
  submitter?: OnChainSubmitter;
  isAlreadyResolved?: (marketId: string) => Promise<boolean>;
  maxRetries?: number;
  metrics?: AggregatorMetrics;
}) {
  const recorded: ResolveMarketResult[] = [];
  const retries: { marketId: string; attempt: number }[] = [];

  return {
    recorded,
    retries,
    submitter: overrides.submitter ?? { submitResolution: vi.fn(async () => "tx-hash") },
    isAlreadyResolved: overrides.isAlreadyResolved ?? (async () => false),
    recordResult: async (result: ResolveMarketResult) => {
      recorded.push(result);
    },
    onRetry: (marketId: string, attempt: number) => {
      retries.push({ marketId, attempt });
    },
    maxRetries: overrides.maxRetries,
    retryBackoffMs: 1,
    metrics: overrides.metrics,
  };
}

describe("resolveMarketOnChain", () => {
  it("submits, records, and returns the result on success", async () => {
    const deps = makeDeps({});
    const result = await resolveMarketOnChain(deps, "42", true);

    expect(result).toEqual({ marketId: "42", outcome: true, txHash: "tx-hash" });
    expect(deps.recorded).toEqual([{ marketId: "42", outcome: true, txHash: "tx-hash" }]);
    expect(deps.submitter.submitResolution).toHaveBeenCalledWith("42", true);
  });

  it("is idempotent — skips submission when already resolved", async () => {
    const deps = makeDeps({ isAlreadyResolved: async () => true });
    const result = await resolveMarketOnChain(deps, "42", true);

    expect(result).toBeNull();
    expect(deps.submitter.submitResolution).not.toHaveBeenCalled();
    expect(deps.recorded).toHaveLength(0);
  });

  it("retries transient failures and succeeds", async () => {
    let calls = 0;
    const submitter: OnChainSubmitter = {
      submitResolution: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error("network blip");
        return "tx-hash-3";
      }),
    };
    const deps = makeDeps({ submitter, maxRetries: 5 });

    const result = await resolveMarketOnChain(deps, "42", false);

    expect(result).toEqual({ marketId: "42", outcome: false, txHash: "tx-hash-3" });
    expect(calls).toBe(3);
    expect(deps.retries).toEqual([
      { marketId: "42", attempt: 1 },
      { marketId: "42", attempt: 2 },
    ]);
  });

  it("throws after exhausting retries and alerts on every attempt", async () => {
    const submitter: OnChainSubmitter = {
      submitResolution: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    };
    const deps = makeDeps({ submitter, maxRetries: 2 });

    await expect(resolveMarketOnChain(deps, "42", true)).rejects.toThrow(
      "resolve_market failed for market 42 after 2 attempt(s): rpc down",
    );
    expect(submitter.submitResolution).toHaveBeenCalledTimes(2);
    expect(deps.retries).toHaveLength(2);
    expect(deps.recorded).toHaveLength(0);
  });

  it("rejects a blank marketId", async () => {
    const deps = makeDeps({});
    await expect(resolveMarketOnChain(deps, "  ", true)).rejects.toThrow("marketId is required");
  });

  // ── oracle_resolution_lag_h integration ────────────────────────────────────

  it("records oracle_resolution_lag_h when metrics and endTime are provided", async () => {
    const metrics = new AggregatorMetrics();
    const endTime = 1_000_000; // Unix seconds in the past
    const deps = makeDeps({ metrics });

    const result = await resolveMarketOnChain(deps, "77", true, endTime);

    // lag should be positive (resolved after expiry)
    expect(result).not.toBeNull();
    expect(typeof result!.lagHours).toBe("number");
    expect(result!.lagHours).toBeGreaterThanOrEqual(0);

    // metric is recorded in the collector
    expect(metrics.totalResolved).toBe(1);
    const named = metrics.getMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "77");
    expect(named).not.toBeNull();
    expect(named!.name).toBe("oracle_resolution_lag_h");
    expect(named!.marketId).toBe("77");
  });

  it("does not record metrics when metrics dependency is absent", async () => {
    const deps = makeDeps({}); // no metrics
    const result = await resolveMarketOnChain(deps, "42", true, 1_000_000);

    expect(result).not.toBeNull();
    expect(result!.lagHours).toBeUndefined();
  });

  it("does not record metrics when endTime is absent even if metrics is provided", async () => {
    const metrics = new AggregatorMetrics();
    const deps = makeDeps({ metrics });

    const result = await resolveMarketOnChain(deps, "42", true); // no endTime

    expect(result).not.toBeNull();
    expect(result!.lagHours).toBeUndefined();
    expect(metrics.totalResolved).toBe(0);
  });

  it("records lag in dry-run mode when metrics and endTime are provided", async () => {
    const metrics = new AggregatorMetrics();
    const endTime = 1_000_000;
    const deps = { ...makeDeps({ metrics }), dryRun: true };

    const result = await resolveMarketOnChain(deps, "55", false, endTime);

    expect(result).not.toBeNull();
    expect(result!.dryRun).toBe(true);
    expect(typeof result!.lagHours).toBe("number");
    expect(metrics.totalResolved).toBe(1);
  });

  it("serializeMetric produces correct Prometheus line after resolution", async () => {
    const metrics = new AggregatorMetrics();
    const endTime = 1_000_000;
    const deps = makeDeps({ metrics });

    await resolveMarketOnChain(deps, "88", true, endTime);

    const line = metrics.serializeMetric(ORACLE_RESOLUTION_LAG_H_METRIC, "88");
    expect(line).toMatch(/^oracle_resolution_lag_h\{market_id="88"\} /);
  });
});
