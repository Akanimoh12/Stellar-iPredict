/**
 * Tests for the shared error hierarchy (issue #633).
 *
 * Uses `node:test` like the rest of the shared package; `npm test` compiles
 * first and runs the emitted JS from `dist/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PermanentError as RetryPermanentError,
  classifyFailure,
  isRetryableError,
  withRetry,
} from "./retry.js";
import {
  PermanentError,
  ProgrammingError,
  ServiceError,
  TransientError,
  classifyHttpStatus,
  getErrorClassification,
  isProgrammingError,
} from "./errors.js";

test("each error class carries its classification and a derived retryable flag", () => {
  const transient = new TransientError("network blip");
  const permanent = new PermanentError("already finalized");
  const programming = new ProgrammingError("invariant broken");

  assert.equal(transient.classification, "transient");
  assert.equal(transient.retryable, true);
  assert.equal(permanent.classification, "permanent");
  assert.equal(permanent.retryable, false);
  assert.equal(programming.classification, "programming");
  assert.equal(programming.retryable, false);

  for (const error of [transient, permanent, programming]) {
    assert.ok(error instanceof ServiceError);
    assert.ok(error instanceof Error);
  }
});

test("the retry module's PermanentError is the same class as the shared one", () => {
  assert.equal(RetryPermanentError, PermanentError);
  assert.equal(new PermanentError("x").name, "PermanentError");
});

test("errors keep their cause", () => {
  const cause = new Error("socket hang up");
  const error = new TransientError("submit failed", { cause });
  assert.equal(error.cause, cause);
});

test("classifyHttpStatus marks throttling, timeouts and 5xx transient; other 4xx permanent", () => {
  assert.equal(classifyHttpStatus(408), "transient");
  assert.equal(classifyHttpStatus(425), "transient");
  assert.equal(classifyHttpStatus(429), "transient");
  assert.equal(classifyHttpStatus(500), "transient");
  assert.equal(classifyHttpStatus(503), "transient");
  assert.equal(classifyHttpStatus(400), "permanent");
  assert.equal(classifyHttpStatus(401), "permanent");
  assert.equal(classifyHttpStatus(404), "permanent");
});

test("a programming error is never retryable, even when wrapped in a transient-looking shape", () => {
  const error = new ProgrammingError("market id was undefined");
  assert.equal(isProgrammingError(error), true);
  assert.equal(isRetryableError(error), false);
  assert.equal(classifyFailure(error).kind, "permanent");
});

test("ReferenceError and SyntaxError are programming errors", () => {
  assert.equal(isProgrammingError(new ReferenceError("x is not defined")), true);
  assert.equal(isProgrammingError(new SyntaxError("unexpected token")), true);
  assert.equal(isRetryableError(new ReferenceError("x is not defined")), false);
});

test("a bare TypeError is a programming error; a TypeError with a cause (fetch failure) is not", () => {
  // Reading a property of undefined: a bug.
  assert.equal(isProgrammingError(new TypeError("Cannot read properties of undefined")), true);
  assert.equal(isRetryableError(new TypeError("Cannot read properties of undefined")), false);

  // Node's fetch wraps network failures in a TypeError that carries the cause.
  const fetchFailure = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  assert.equal(isProgrammingError(fetchFailure), false);
  assert.equal(isRetryableError(fetchFailure), true);
});

test("a transient ServiceError is retried; a permanent one is not", () => {
  assert.equal(isRetryableError(new TransientError("try again later")), true);
  assert.equal(isRetryableError(new PermanentError("nope")), false);
});

test("retry does not re-run a programming error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls += 1;
        throw new ProgrammingError("bug");
      },
      { maxRetries: 5, sleep: async () => undefined },
    ),
  );
  assert.equal(calls, 1);
});

test("retry re-runs a transient error until it succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls += 1;
      if (calls < 3) throw new TransientError("busy");
      return "ok";
    },
    { maxRetries: 5, sleep: async () => undefined, random: () => 0 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("getErrorClassification reports the category of classified values only", () => {
  assert.equal(getErrorClassification(new TransientError("x")), "transient");
  assert.equal(getErrorClassification(new TypeError("bug")), "programming");
  assert.equal(getErrorClassification(new Error("unclassified")), undefined);
  assert.equal(getErrorClassification("a string"), undefined);
});
