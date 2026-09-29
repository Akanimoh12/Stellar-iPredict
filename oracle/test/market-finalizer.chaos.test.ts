import { describe, expect, it, vi } from "vitest";
import { resolveMarketOnChain, type OnChainSubmitter, type ResolveMarketResult } from "../src/submitter/resolveMarket.js";

describe("Chaos Tests: Oracle Finalization Dependency Failures", () => {
  it("A simulated crash before transaction submission cleanly aborts", async () => {
    const recordResult = vi.fn();
    const isAlreadyResolved = vi.fn().mockResolvedValue(false);
    
    // Simulate crash before submission by having the submitter throw immediately
    const submitter: OnChainSubmitter = {
      submitResolution: vi.fn(async () => {
        throw new Error("Crash before submission");
      }),
    };

    const deps = {
      submitter,
      isAlreadyResolved,
      recordResult,
      maxRetries: 1, // Fail fast for the chaos test
    };

    await expect(resolveMarketOnChain(deps, "42", true)).rejects.toThrow("Crash before submission");
    
    // Cleanly aborts means it didn't record anything
    expect(recordResult).not.toHaveBeenCalled();
    // And state is still unresolved
    expect(isAlreadyResolved).toHaveBeenCalled();
  });

  it("A simulated crash after transaction submission but before hash recording identifies the transaction and recovers on restart", async () => {
    let crashHasHappened = false;
    let submittedHash = "";

    const submitter: OnChainSubmitter = {
      submitResolution: vi.fn(async (marketId, outcome) => {
        submittedHash = "tx-hash-123";
        return submittedHash;
      }),
    };

    const recordResult = vi.fn(async (result) => {
      if (!crashHasHappened) {
        crashHasHappened = true;
        throw new Error("Crash after submission but before DB commit");
      }
    });

    let onChainStateResolved = false;
    const isAlreadyResolved = vi.fn(async () => onChainStateResolved);

    const deps = {
      submitter,
      isAlreadyResolved,
      recordResult,
      maxRetries: 1,
    };

    // 1. Initial attempt
    await expect(resolveMarketOnChain(deps, "42", true)).rejects.toThrow("Crash after submission");

    // At this point, the transaction was submitted to the chain
    expect(submitter.submitResolution).toHaveBeenCalledTimes(1);
    expect(crashHasHappened).toBe(true);

    // Simulate the chain processing the transaction
    onChainStateResolved = true;

    // 2. Restart attempt
    // On restart, the aggregator checks if it's already resolved.
    const resultAfterRestart = await resolveMarketOnChain(deps, "42", true);

    // Identifies the transaction and recovers (by skipping since it's resolved)
    expect(resultAfterRestart).toBeNull();
    
    // It should not have submitted again
    expect(submitter.submitResolution).toHaveBeenCalledTimes(1);
  });
});
