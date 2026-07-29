import { describe, expect, it, vi } from "vitest";
import {
  withRetry,
  isTransientError,
  isRateLimitError,
  getRetryAfterMs,
  getStatusCode,
  RetryExhaustedError,
  type RetryAttempt,
} from "../rpc/retry.js";

/** A sleep stub that records the delays it was asked to wait, without waiting. */
function recordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { delays, sleep };
}

describe("withRetry", () => {
  it("returns immediately when the call succeeds on the first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const { delays, sleep } = recordingSleep();

    const result = await withRetry(fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it("retries transient failures and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue("recovered");
    const { delays, sleep } = recordingSleep();

    const result = await withRetry(fn, { sleep });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });

  it("backs off exponentially with full jitter, bounded by a growing ceiling", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    // With random ~1, full jitter sits just under each ceiling: base * 2^attempt.
    const { delays: highJitter, sleep: highSleep } = recordingSleep();
    await expect(
      withRetry(fn, { sleep: highSleep, maxRetries: 3, baseDelayMs: 100, random: () => 0.999999 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    // ceilings: 100, 200, 400 (then give up) — floored full jitter lands at 99, 199, 399.
    expect(highJitter).toEqual([99, 199, 399]);

    // With random == 0, full jitter collapses every delay to zero.
    const { delays: zeroJitter, sleep: zeroSleep } = recordingSleep();
    await expect(
      withRetry(fn, { sleep: zeroSleep, maxRetries: 3, baseDelayMs: 100, random: () => 0 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(zeroJitter).toEqual([0, 0, 0]);
  });

  it("never exceeds maxDelayMs", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const { delays, sleep } = recordingSleep();

    await expect(
      withRetry(fn, {
        sleep,
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        random: () => 0.999999,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(Math.max(...delays)).toBeLessThanOrEqual(2000);
  });

  it("honours a 429 Retry-After header (seconds) over the computed backoff", async () => {
    const rateLimited = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      response: { headers: { "retry-after": "3" } },
    });
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue("ok");
    const { delays, sleep } = recordingSleep();

    const result = await withRetry(fn, { sleep, baseDelayMs: 50, random: () => 0 });

    expect(result).toBe("ok");
    expect(delays).toEqual([3000]);
  });

  it("caps the 429 Retry-After at maxDelayMs", async () => {
    const rateLimited = Object.assign(new Error("429"), {
      response: { headers: { "retry-after": "120" } },
    });
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue("ok");
    const { delays, sleep } = recordingSleep();

    await withRetry(fn, { sleep, maxDelayMs: 10_000 });

    expect(delays).toEqual([10_000]);
  });

  it("does not retry non-transient errors (4xx other than 429)", async () => {
    const badRequest = Object.assign(new Error("bad request"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(badRequest);
    const { delays, sleep } = recordingSleep();

    await expect(withRetry(fn, { sleep })).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it("does not retry a LedgerGapError", async () => {
    const gap = Object.assign(new Error("ledger gap"), { name: "LedgerGapError" });
    const fn = vi.fn().mockRejectedValue(gap);
    const { sleep } = recordingSleep();

    await expect(withRetry(fn, { sleep })).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the cap and surfaces the last error as the cause", async () => {
    const lastError = new Error("still failing");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValue(lastError);
    const { delays, sleep } = recordingSleep();

    const error = (await withRetry(fn, { sleep, maxRetries: 2 }).catch(
      (e) => e,
    )) as RetryExhaustedError;

    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect(error.cause).toBe(lastError);
    expect(error.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });

  it("invokes onRetry before each backoff with attempt metadata", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockResolvedValue("ok");
    const { sleep } = recordingSleep();
    const attempts: RetryAttempt[] = [];

    await withRetry(fn, { sleep, onRetry: (info) => attempts.push(info) });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt).toBe(1);
    expect(attempts[0].error).toBeInstanceOf(Error);
  });

  it("respects a custom isRetryable predicate", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("nope"));
    const { sleep } = recordingSleep();

    await expect(
      withRetry(fn, { sleep, isRetryable: () => false }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("error classification helpers", () => {
  it("getStatusCode reads status from several shapes", () => {
    expect(getStatusCode({ status: 503 })).toBe(503);
    expect(getStatusCode({ statusCode: 429 })).toBe(429);
    expect(getStatusCode({ response: { status: 500 } })).toBe(500);
    expect(getStatusCode({ status: "404" })).toBe(404);
    expect(getStatusCode(new Error("plain"))).toBeUndefined();
  });

  it("isRateLimitError detects status and message forms", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 429 returned"))).toBe(true);
    expect(isRateLimitError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("ordinary failure"))).toBe(false);
  });

  it("getRetryAfterMs parses seconds and HTTP dates", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(getRetryAfterMs({ headers: { "retry-after": "5" } })).toBe(5000);
    expect(
      getRetryAfterMs(
        { headers: { "retry-after": "2026-01-01T00:00:10Z" } },
        now,
      ),
    ).toBe(10_000);
    expect(getRetryAfterMs(new Error("no header"))).toBeUndefined();
  });

  it("isTransientError treats unknown/5xx/429 as transient and 4xx as permanent", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError({ status: 502 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError({ name: "LedgerGapError" })).toBe(false);
  });
});
