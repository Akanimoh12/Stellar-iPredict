/**
 * Tests for the shared retry utility (issue #641).
 *
 * Run with `npm test --workspace=@ipredict/shared`. The package has no test
 * framework dependency on purpose — these use `node:test`, which is why the
 * script compiles first and runs the emitted JS from `dist/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RETRY_CONFIG,
  HTTP_RETRY_CONFIG,
  PermanentError,
  RetryExhaustedError,
  RetryTimeoutError,
  RPC_RETRY_CONFIG,
  SUBMIT_RETRY_CONFIG,
  classifyFailure,
  computeBackoffDelayMs,
  computeDelayMs,
  getRetryAfterMs,
  getStatusCode,
  isRetryableError,
  jitteredDelayMs,
  unwrapError,
  withRetry,
  type RetryAttempt,
} from "./retry.js";

/** A sleep stub that records the delays it was asked to wait, without waiting. */
function recordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { delays, sleep };
}

/** Deterministic 32-bit PRNG (mulberry32) so distribution tests are stable. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classifyFailure decides by error type, not by message", () => {
  assert.equal(classifyFailure({ status: 429 }).kind, "rate-limit");
  assert.equal(classifyFailure({ status: 429 }).retryable, true);
  assert.equal(classifyFailure({ status: 503 }).kind, "server");
  assert.equal(classifyFailure({ status: 503 }).retryable, true);
  assert.equal(classifyFailure({ status: 408 }).kind, "timeout");
  assert.equal(classifyFailure({ status: 404 }).kind, "client");
  assert.equal(classifyFailure({ status: 404 }).retryable, false);
  assert.equal(classifyFailure({ status: 401 }).retryable, false);
});

test("classifyFailure ignores the message when deciding retryability", () => {
  // The old implementations grepped for "429" in the text. A provider that
  // rewords its error must not change whether we retry.
  const worded = new Error("HTTP 429 Too Many Requests");
  assert.equal(classifyFailure(worded).kind, "network");
  assert.equal(classifyFailure(worded).retryable, true);

  const fatal = new Error("500 Internal Server Error");
  assert.equal(classifyFailure(fatal).kind, "network");
  assert.equal(classifyFailure(fatal).retryable, true);
});

test("classifyFailure treats a failure without a status as a transport failure", () => {
  assert.equal(classifyFailure(new Error("socket hang up")).kind, "network");
  assert.equal(classifyFailure(new Error("socket hang up")).retryable, true);
  assert.equal(classifyFailure(undefined).retryable, true);
});

test("classifyFailure honours an explicit retryable flag", () => {
  assert.equal(classifyFailure({ status: 429, retryable: false }).retryable, false);
  assert.equal(classifyFailure({ retryable: true }).retryable, true);
});

test("classifyFailure treats PermanentError as permanent", () => {
  const error = new PermanentError("ledger gap");
  assert.equal(classifyFailure(error).kind, "permanent");
  assert.equal(classifyFailure(error).retryable, false);
});

test("classifyFailure honours configured permanent error names", () => {
  const gap = Object.assign(new Error("ledger gap"), { name: "LedgerGapError" });
  assert.equal(classifyFailure(gap).retryable, true);
  assert.equal(
    classifyFailure(gap, { permanentErrorNames: ["LedgerGapError"] }).kind,
    "permanent",
  );
});

test("classifyFailure distinguishes an attempt timeout from a total timeout", () => {
  assert.equal(classifyFailure(new RetryTimeoutError("attempt", "attempt")).retryable, true);
  assert.equal(classifyFailure(new RetryTimeoutError("total", "total")).retryable, false);
});

test("getStatusCode reads status from several shapes", () => {
  assert.equal(getStatusCode({ status: 503 }), 503);
  assert.equal(getStatusCode({ statusCode: 429 }), 429);
  assert.equal(getStatusCode({ response: { status: 500 } }), 500);
  assert.equal(getStatusCode({ status: "404" }), 404);
  assert.equal(getStatusCode(new Error("plain")), undefined);
  // A Node error code is not an HTTP status.
  assert.equal(getStatusCode(Object.assign(new Error("reset"), { code: "ECONNRESET" })), undefined);
});

test("getRetryAfterMs parses seconds, HTTP dates and adapter errors", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(getRetryAfterMs({ headers: { "retry-after": "5" } }), 5000);
  assert.equal(
    getRetryAfterMs({ headers: { "retry-after": "2026-01-01T00:00:10Z" } }, now),
    10_000,
  );
  assert.equal(getRetryAfterMs({ retryAfterMs: 120_000 }), 120_000);
  assert.equal(getRetryAfterMs(new Error("no header")), undefined);
});

test("unwrapError peels retry wrappers off a failure", () => {
  const root = new Error("root cause");
  const wrapped = new RetryExhaustedError(3, root);
  assert.equal(unwrapError(wrapped), root);
  assert.equal(unwrapError(root), root);
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test("jitteredDelayMs returns a floor draw inside [0, ceiling)", () => {
  assert.equal(jitteredDelayMs(1000, () => 0), 0);
  assert.equal(jitteredDelayMs(1000, () => 0.5), 500);
  assert.equal(jitteredDelayMs(1000, () => 0.999999), 999);
  assert.equal(jitteredDelayMs(0, () => 0.9), 0);
  assert.equal(jitteredDelayMs(-100, () => 0.9), 0);
});

test("jitteredDelayMs spreads a seeded distribution across the whole interval", () => {
  const random = seededRandom(0xc0ffee);
  const samples = Array.from({ length: 500 }, () => jitteredDelayMs(1000, random));

  assert.ok(Math.min(...samples) >= 0);
  assert.ok(Math.max(...samples) < 1000);
  assert.ok(new Set(samples).size > 200);
  assert.ok(new Set(samples.map((s) => Math.floor(s / 100))).size >= 9);
});

test("computeDelayMs grows exponentially and honours the cap", () => {
  const options = {
    backoff: "exponential" as const,
    jitter: "none" as const,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  };
  assert.equal(computeDelayMs(0, options, () => 0), 100);
  assert.equal(computeDelayMs(1, options, () => 0), 200);
  assert.equal(computeDelayMs(2, options, () => 0), 400);
  assert.equal(computeDelayMs(10, options, () => 0), 1000);
});

test("computeDelayMs supports linear and fixed curves", () => {
  const linear = {
    backoff: "linear" as const,
    jitter: "none" as const,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  };
  assert.equal(computeDelayMs(0, linear, () => 0), 100);
  assert.equal(computeDelayMs(2, linear, () => 0), 300);

  const fixed = { ...linear, backoff: "fixed" as const };
  assert.equal(computeDelayMs(3, fixed, () => 0), 100);
});

test("computeBackoffDelayMs matches the shared exponential full-jitter curve", () => {
  const random = () => 1;
  assert.equal(computeBackoffDelayMs(0, 100, 10_000, random), 100);
  assert.equal(computeBackoffDelayMs(1, 100, 10_000, random), 200);
  assert.equal(computeBackoffDelayMs(2, 100, 10_000, random), 400);
  assert.equal(computeBackoffDelayMs(10, 100, 10_000, random), 10_000);
  assert.equal(computeBackoffDelayMs(1, 100, 10_000, () => 0.5), 100);
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

test("withRetry returns immediately when the call succeeds", async () => {
  let calls = 0;
  const { delays, sleep } = recordingSleep();

  const result = await withRetry(
    async () => {
      calls += 1;
      return "ok";
    },
    { sleep },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.equal(delays.length, 0);
});

test("withRetry retries transient failures and eventually succeeds", async () => {
  let calls = 0;
  const { delays, sleep } = recordingSleep();

  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("network timeout");
      return "recovered";
    },
    { sleep },
  );

  assert.equal(result, "recovered");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test("withRetry backs off exponentially with full jitter", async () => {
  const { delays, sleep } = recordingSleep();

  await assert.rejects(
    withRetry(
      async () => {
        throw new Error("boom");
      },
      { sleep, maxRetries: 3, baseDelayMs: 100, random: () => 0.999999 },
    ),
    RetryExhaustedError,
  );

  assert.deepEqual(delays, [99, 199, 399]);
});

test("withRetry draws a fresh jitter sample for each attempt", async () => {
  const { delays, sleep } = recordingSleep();
  const draws = [0, 0.5, 0.999999];
  let i = 0;

  await assert.rejects(
    withRetry(
      async () => {
        throw new Error("boom");
      },
      { sleep, maxRetries: 3, baseDelayMs: 100, random: () => draws[i++] },
    ),
    RetryExhaustedError,
  );

  assert.deepEqual(delays, [0, 100, 399]);
  assert.equal(i, 3);
});

test("withRetry never exceeds maxDelayMs", async () => {
  const { delays, sleep } = recordingSleep();

  await assert.rejects(
    withRetry(
      async () => {
        throw new Error("boom");
      },
      { sleep, maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 2000, random: () => 0.999999 },
    ),
    RetryExhaustedError,
  );

  assert.ok(Math.max(...delays) <= 2000);
});

test("withRetry honours a Retry-After header over the computed backoff", async () => {
  const rateLimited = Object.assign(new Error("Too Many Requests"), {
    status: 429,
    response: { headers: { "retry-after": "3" } },
  });
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw rateLimited;
      return "ok";
    },
    { sleep, baseDelayMs: 50, random: () => 0 },
  );

  assert.deepEqual(delays, [3000]);
});

test("withRetry caps a Retry-After at maxDelayMs", async () => {
  const rateLimited = Object.assign(new Error("429"), {
    response: { headers: { "retry-after": "120" } },
  });
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw rateLimited;
      return "ok";
    },
    { sleep, maxDelayMs: 10_000 },
  );

  assert.deepEqual(delays, [10_000]);
});

test("withRetry does not retry a non-retryable failure", async () => {
  let calls = 0;
  const { delays, sleep } = recordingSleep();

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
      { sleep },
    ),
    RetryExhaustedError,
  );

  assert.equal(calls, 1);
  assert.equal(delays.length, 0);
});

test("withRetry does not retry a permanent failure", async () => {
  let calls = 0;
  const { sleep } = recordingSleep();

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new PermanentError("ledger gap");
      },
      { sleep },
    ),
    RetryExhaustedError,
  );

  assert.equal(calls, 1);
});

test("withRetry surfaces the last failure as the cause", async () => {
  const lastError = new Error("still failing");
  const { sleep } = recordingSleep();
  let calls = 0;

  const error = await withRetry(
    async () => {
      calls += 1;
      throw calls === 1 ? new Error("first") : lastError;
    },
    { sleep, maxRetries: 2 },
  ).catch((e: unknown) => e);

  assert.ok(error instanceof RetryExhaustedError);
  assert.equal((error as RetryExhaustedError).cause, lastError);
  assert.equal((error as RetryExhaustedError).attempts, 3);
  assert.equal(calls, 3);
});

test("withRetry invokes onRetry before each backoff with attempt metadata", async () => {
  const attempts: RetryAttempt[] = [];
  const { sleep } = recordingSleep();
  let calls = 0;

  await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("a");
      return "ok";
    },
    { sleep, onRetry: (info) => attempts.push(info) },
  );

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attempt, 1);
  assert.ok(attempts[0].error instanceof Error);
});

test("withRetry respects a custom isRetryable predicate", async () => {
  let calls = 0;
  const { sleep } = recordingSleep();

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("nope");
      },
      { sleep, isRetryable: () => false },
    ),
    RetryExhaustedError,
  );

  assert.equal(calls, 1);
});

test("withRetry lets a guard stop the sequence successfully", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  const result = await withRetry<boolean>(
    async () => {
      calls += 1;
      throw new Error("boom");
    },
    {
      sleep,
      maxRetries: 3,
      beforeRetry: () => ({ action: "stop", value: true }),
    },
  );

  assert.equal(result, true);
  assert.equal(calls, 1);
  assert.equal(delays.length, 1);
});

test("withRetry lets a guard skip an attempt without running it", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      { sleep, maxRetries: 2, beforeRetry: () => ({ action: "skip" }) },
    ),
    RetryExhaustedError,
  );

  // The first attempt ran, the two retries were skipped.
  assert.equal(calls, 1);
  assert.equal(delays.length, 2);
});

test("withRetry aborts the attempt signal when the attempt times out", async () => {
  const { sleep } = recordingSleep();
  let aborted = false;
  let calls = 0;

  const error = await withRetry(
    (_attempt, signal) =>
      new Promise((_, reject) => {
        calls += 1;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
    { sleep, attemptTimeoutMs: 20, maxRetries: 1 },
  ).catch((e: unknown) => e);

  assert.ok(error instanceof RetryExhaustedError);
  const cause = (error as RetryExhaustedError).cause;
  assert.ok(cause instanceof RetryTimeoutError);
  assert.equal((cause as RetryTimeoutError).scope, "attempt");
  assert.ok(aborted);
  // An attempt timeout is transient, so it is retried.
  assert.equal(calls, 2);
});

test("withRetry gives up when the total budget is spent", async () => {
  const { sleep } = recordingSleep();
  let calls = 0;

  const error = await withRetry(
    async () => {
      calls += 1;
      throw new Error("boom");
    },
    {
      sleep,
      maxRetries: 10,
      baseDelayMs: 1000,
      random: () => 0.5,
      totalTimeoutMs: 1,
      label: "test",
    },
  ).catch((e: unknown) => e);

  assert.ok(error instanceof RetryTimeoutError);
  assert.equal((error as RetryTimeoutError).scope, "total");
  assert.equal(calls, 1);
});

test("withRetry can be configured to surface the raw failure", async () => {
  const raw = Object.assign(new Error("Request failed with status 404"), { status: 404 });
  const { sleep } = recordingSleep();

  const error = await withRetry(
    async () => {
      throw raw;
    },
    { sleep, finalError: (failure) => failure as Error },
  ).catch((e: unknown) => e);

  assert.equal(error, raw);
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

test("the profiles all share one backoff shape and differ only in budget", () => {
  for (const profile of [RPC_RETRY_CONFIG, HTTP_RETRY_CONFIG, SUBMIT_RETRY_CONFIG]) {
    assert.equal(profile.backoff, "exponential");
    assert.equal(profile.jitter, "full");
  }
  assert.equal(RPC_RETRY_CONFIG.maxRetries, 5);
  assert.equal(HTTP_RETRY_CONFIG.maxRetries, 3);
  assert.equal(DEFAULT_RETRY_CONFIG.jitter, "full");
});

test("isRetryableError mirrors the classification", () => {
  assert.equal(isRetryableError({ status: 500 }), true);
  assert.equal(isRetryableError({ status: 400 }), false);
  assert.equal(isRetryableError(new PermanentError("nope")), false);
});
