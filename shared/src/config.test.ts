/**
 * Tests for the shared configuration pattern (issue #631).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  formatConfigIssues,
  parseConfig,
  reportStartupFailure,
  type ConfigSchema,
} from "./config.js";

/** A tiny structural schema: requires DATABASE_URL and a positive PORT. */
const schema: ConfigSchema<{ DATABASE_URL: string; PORT: number }> = {
  safeParse(input) {
    const env = input as Record<string, unknown>;
    const issues: { path: string[]; message: string }[] = [];
    if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL === "") {
      issues.push({ path: ["DATABASE_URL"], message: "DATABASE_URL is required" });
    }
    const port = Number(env.PORT ?? 4000);
    if (!Number.isInteger(port) || port <= 0) {
      issues.push({ path: ["PORT"], message: "PORT must be a positive integer" });
    }
    if (issues.length > 0) return { success: false, error: { issues } };
    return {
      success: true,
      data: { DATABASE_URL: env.DATABASE_URL as string, PORT: port },
    };
  },
};

test("parseConfig returns the parsed value for valid input", () => {
  const config = parseConfig("ipredict-test", schema, { DATABASE_URL: "postgres://x" });
  assert.deepEqual(config, { DATABASE_URL: "postgres://x", PORT: 4000 });
});

test("parseConfig throws a ConfigError naming the service and every issue", () => {
  assert.throws(
    () => parseConfig("ipredict-test", schema, { PORT: "0" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.service, "ipredict-test");
      assert.equal(error.issues.length, 2);
      assert.equal(
        error.message,
        [
          "[ipredict-test] invalid configuration:",
          "  DATABASE_URL: DATABASE_URL is required",
          "  PORT: PORT must be a positive integer",
        ].join("\n"),
      );
      return true;
    },
  );
});

test("parseConfig does not exit or write to stderr on failure", () => {
  const realExit = process.exit;
  const realWrite = process.stderr.write;
  let exited = false;
  let wrote = false;
  process.exit = (() => {
    exited = true;
    throw new Error("process.exit must not be called from library code");
  }) as typeof process.exit;
  process.stderr.write = ((..._args: unknown[]) => {
    wrote = true;
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.throws(() => parseConfig("ipredict-test", schema, {}), ConfigError);
  } finally {
    process.exit = realExit;
    process.stderr.write = realWrite;
  }
  assert.equal(exited, false);
  assert.equal(wrote, false);
});

test("an issue with an empty path is reported under the word config", () => {
  assert.equal(
    formatConfigIssues("ipredict-test", [{ path: [], message: "input must be an object" }]),
    "[ipredict-test] invalid configuration:\n  config: input must be an object",
  );
});

test("nested and numeric path segments are joined with dots", () => {
  assert.equal(
    formatConfigIssues("ipredict-test", [{ path: ["replicas", 0, "url"], message: "bad" }]),
    "[ipredict-test] invalid configuration:\n  replicas.0.url: bad",
  );
});

test("reportStartupFailure prints a ConfigError's message and nothing else", () => {
  const lines: string[] = [];
  const error = new ConfigError("ipredict-test", [{ path: ["PORT"], message: "bad" }]);
  reportStartupFailure("ipredict-test", error, (line) => lines.push(line));
  assert.deepEqual(lines, ["[ipredict-test] invalid configuration:\n  PORT: bad\n"]);
});

test("reportStartupFailure labels any other failure as fatal", () => {
  const lines: string[] = [];
  reportStartupFailure("ipredict-test", new Error("boom"), (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[ipredict-test\] fatal: Error: boom/);
});
