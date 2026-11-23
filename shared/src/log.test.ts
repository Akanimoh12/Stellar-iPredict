/**
 * Tests for the shared logger and its canonical field names (issue #630).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LOG_FIELDS,
  MAX_REQUEST_ID_LENGTH,
  createLogger,
  isValidRequestId,
  parseLogLevel,
  serializeError,
} from "./log.js";

function capture(level = "debug") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    timestamp: () => "2026-11-21T00:00:00.000Z",
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

test("every record has timestamp, level and message under the canonical names", () => {
  const { logger, lines } = capture();
  logger.info("market finalized", { marketId: "7" });

  assert.deepEqual(lines, [
    {
      timestamp: "2026-11-21T00:00:00.000Z",
      level: "info",
      message: "market finalized",
      marketId: "7",
    },
  ]);
  assert.equal(LOG_FIELDS.timestamp, "timestamp");
  assert.equal(LOG_FIELDS.message, "message");
  assert.equal(LOG_FIELDS.level, "level");
});

test("bindings are merged into every record and per-call fields win on collision", () => {
  const { logger, lines } = capture();
  const child = logger.child({ service: "oracle-aggregator", requestId: "a" });
  child.warn("retrying", { requestId: "b" });

  assert.equal(lines[0]?.service, "oracle-aggregator");
  assert.equal(lines[0]?.requestId, "b");
});

test("records below the configured level are dropped", () => {
  const { logger, lines } = capture("warn");
  logger.debug("noise");
  logger.info("noise");
  logger.warn("kept");
  logger.error("kept too");

  assert.deepEqual(
    lines.map((line) => line.level),
    ["warn", "error"],
  );
});

test("an Error passed as a field is serialised as name, message and stack", () => {
  const { logger, lines } = capture();
  logger.error("submit failed", { error: new RangeError("out of range") });

  const error = lines[0]?.error as Record<string, unknown>;
  assert.equal(error.name, "RangeError");
  assert.equal(error.message, "out of range");
  assert.equal(typeof error.stack, "string");
});

test("serializeError keeps name, message and stack", () => {
  const serialized = serializeError(new TypeError("bad"));
  assert.deepEqual(Object.keys(serialized).sort(), ["message", "name", "stack"]);
});

test("parseLogLevel defaults unknown values to info", () => {
  assert.equal(parseLogLevel("WARN"), "warn");
  assert.equal(parseLogLevel("  debug "), "debug");
  assert.equal(parseLogLevel("verbose"), "info");
  assert.equal(parseLogLevel(undefined), "info");
});

test("isValidRequestId accepts the safe alphabet within the length limit", () => {
  assert.equal(isValidRequestId("req-1.2:3_ok"), true);
  assert.equal(isValidRequestId(""), false);
  assert.equal(isValidRequestId("has space"), false);
  assert.equal(isValidRequestId("x".repeat(MAX_REQUEST_ID_LENGTH + 1)), false);
  assert.equal(isValidRequestId(42), false);
});
