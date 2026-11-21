/**
 * Oracle errors are classified by type, and config failures throw (issues
 * #631 and #633).
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigError, isRetryableError, ProgrammingError, TransientError } from "@ipredict/shared";
import { loadAggregatorConfig } from "../src/aggregator/config.js";
import {
  FinalizationOutcomeMismatchError,
  MarketAlreadyFinalizedError,
} from "../src/aggregator/market-finalizer.js";
import { submitWithRetry } from "../src/aggregator/submit-with-retry.js";

const noSleep = async () => undefined;

describe("oracle finalization errors", () => {
  it("MarketAlreadyFinalizedError is permanent: never retried", () => {
    const error = new MarketAlreadyFinalizedError("7");
    expect(error.classification).toBe("permanent");
    expect(isRetryableError(error)).toBe(false);
  });

  it("FinalizationOutcomeMismatchError is permanent: never retried", () => {
    const error = new FinalizationOutcomeMismatchError("7", true, false);
    expect(error.classification).toBe("permanent");
    expect(isRetryableError(error)).toBe(false);
  });

  it("a submission that fails with a programming error is not resent", async () => {
    const submit = vi.fn(async () => {
      throw new ProgrammingError("bond amount was never set");
    });
    const isAlreadyFinalized = vi.fn(async () => false);

    const result = await submitWithRetry("7", submit, isAlreadyFinalized, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      alertThreshold: 99,
      sleep: noSleep,
      random: () => 0,
    });

    expect(result).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a transient submission failure is retried until it succeeds", async () => {
    let calls = 0;
    const submit = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new TransientError("Network busy — please try again later");
    });

    const result = await submitWithRetry("7", submit, async () => false, {
      maxRetries: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      alertThreshold: 99,
      sleep: noSleep,
      random: () => 0,
    });

    expect(result).toBe(true);
    expect(submit).toHaveBeenCalledTimes(3);
  });
});

describe("oracle configuration failures", () => {
  it("throws a ConfigError in the shared format instead of exiting", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not run from the loader");
    }) as never);
    try {
      let caught: unknown;
      try {
        loadAggregatorConfig({ DATABASE_URL: "" , SOROBAN_RPC_URL: "not-a-url" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const error = caught as ConfigError;
      expect(error.service).toBe("ipredict-oracle");
      expect(error.message.startsWith("[ipredict-oracle] invalid configuration:\n")).toBe(true);
      expect(error.message).toContain("SOROBAN_RPC_URL:");
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
