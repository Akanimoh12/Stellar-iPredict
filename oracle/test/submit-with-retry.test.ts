import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelayMs, submitWithRetry } from "../src/aggregator/submit-with-retry.js";

describe("computeBackoffDelayMs", () => {
  it("grows exponentially with attempt number, capped at maxDelayMs", () => {
    const random = () => 1; // upper bound of the jitter window
    expect(computeBackoffDelayMs(0, 100, 10_000, random)).toBe(100);
    expect(computeBackoffDelayMs(1, 100, 10_000, random)).toBe(200);
    expect(computeBackoffDelayMs(2, 100, 10_000, random)).toBe(400);
    expect(computeBackoffDelayMs(10, 100, 10_000, random)).toBe(10_000);
  });

  it("jitters within [0, cappedExponential)", () => {
    const random = () => 0.5;
    expect(computeBackoffDelayMs(1, 100, 10_000, random)).toBe(100);
  });
});

describe("submitWithRetry", () => {
  it("succeeds immediately without retrying on first-attempt success", async () => {
    const submit = vi.fn(async () => undefined);
    const isAlreadyFinalized = vi.fn(async () => false);
    const sleep = vi.fn(async () => undefined);

    const result = await submitWithRetry("m1", submit, isAlreadyFinalized, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      alertThreshold: 3,
      sleep,
    });

    expect(result).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries with backoff and eventually succeeds", async () => {
    let attempts = 0;
    const submit = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("rpc timeout");
    });
    const isAlreadyFinalized = vi.fn(async () => false);
    const sleep = vi.fn(async () => undefined);

    const result = await submitWithRetry("m1", submit, isAlreadyFinalized, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      alertThreshold: 3,
      sleep,
    });

    expect(result).toBe(true);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops retrying and treats it as success if already finalized on-chain", async () => {
    const submit = vi.fn(async () => {
      throw new Error("timed out waiting for response");
    });
    const isAlreadyFinalized = vi.fn(async () => true);
    const sleep = vi.fn(async () => undefined);

    const result = await submitWithRetry("m1", submit, isAlreadyFinalized, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      alertThreshold: 3,
      sleep,
    });

    expect(result).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("exhausts retries, returns false, and fires the persistent-failure alert", async () => {
    const submit = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const isAlreadyFinalized = vi.fn(async () => false);
    const sleep = vi.fn(async () => undefined);
    const onPersistentFailure = vi.fn(async () => undefined);

    const result = await submitWithRetry("m1", submit, isAlreadyFinalized, {
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      alertThreshold: 3,
      sleep,
      onPersistentFailure,
    });

    expect(result).toBe(false);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(onPersistentFailure).toHaveBeenCalledWith(
      expect.objectContaining({ marketId: "m1", attempts: 3 }),
    );
  });

  it("does not alert when attempts are below the alert threshold", async () => {
    const submit = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const isAlreadyFinalized = vi.fn(async () => false);
    const sleep = vi.fn(async () => undefined);
    const onPersistentFailure = vi.fn(async () => undefined);

    await submitWithRetry("m1", submit, isAlreadyFinalized, {
      maxRetries: 1,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      alertThreshold: 5,
      sleep,
      onPersistentFailure,
    });

    expect(onPersistentFailure).not.toHaveBeenCalled();
  });
});
