import { describe, expect, it, vi } from "vitest";
import { resolveMarketOnChain, type OnChainSubmitter, type ResolveMarketResult } from "../src/submitter/resolveMarket.js";

function makeDeps(overrides: {
  submitter?: OnChainSubmitter;
  isAlreadyResolved?: (marketId: string) => Promise<boolean>;
  maxRetries?: number;
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
});
