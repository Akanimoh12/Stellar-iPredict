/**
 * Flaky test detector (Issue #1004).
 *
 * Vitest's `retry` option silently reruns failed tests. This reporter watches
 * the final result of every test case and calls out the ones whose final state
 * is "passed" only after one or more retries, so a green suite cannot hide a
 * flaky test.
 */

import { appendFileSync } from "node:fs";
import type { Reporter } from "vitest/node";

type OnTestCaseResult = NonNullable<Reporter["onTestCaseResult"]>;
type TestCase = Parameters<OnTestCaseResult>[0];

interface FlakyTest {
  file: string;
  name: string;
  retries: number;
}

export default class FlakyTestReporter implements Reporter {
  private readonly flakyTests = new Map<string, FlakyTest>();

  onTestRunStart(): void {
    // Watch mode reuses the same reporter instance; do not report old retries.
    this.flakyTests.clear();
  }

  onTestCaseResult(testCase: TestCase): void {
    const diagnostic = testCase.diagnostic?.();
    if (!diagnostic?.flaky) return;

    const file = testCase.module?.moduleId ?? "unknown file";
    const name = testCase.fullName;
    const retries = diagnostic.retryCount ?? 0;
    this.flakyTests.set(`${file} > ${name}`, { file, name, retries });
  }

  onTestRunEnd(): void {
    if (this.flakyTests.size === 0) {
      console.log("[flaky-detector] No tests passed on retry.");
      return;
    }

    const entries = [...this.flakyTests.values()];
    const lines = entries.map(
      ({ file, name, retries }) =>
        `  - ${name} (${file}) — passed on retry ${retries} of 1 allowed`,
    );

    console.log(
      `[flaky-detector] ${entries.length} test(s) passed on retry:`,
    );
    for (const line of lines) console.log(line);

    // Surface the same list in the GitHub Actions job summary when available.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      try {
        appendFileSync(
          summaryPath,
          `### Flaky tests (passed on retry)\n\n${lines.map((line) => line.trim()).join("\n")}\n\n`,
        );
      } catch {
        // A missing/unwritable summary file must never fail the test run.
      }
    }
  }
}
