import FlakyTestReporter from "./scripts/flaky-test-reporter";

// Issue #1004: retry each failed test once and report the tests that only pass
// on retry. VITEST_RETRY=0 disables retries (useful when diagnosing a failure);
// the default is exactly one retry.
const configuredRetries = Number.parseInt(process.env.VITEST_RETRY ?? "1", 10);
const retry = Number.isInteger(configuredRetries) && configuredRetries >= 0
  ? configuredRetries
  : 1;

export default {
  test: {
    include: ["test/**/*.test.ts", "oracle/test/**/*.test.ts", "oracle/src/**/*.test.ts"],
    retry,
    reporters: ["default", new FlakyTestReporter()],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",

    },
  },
};
