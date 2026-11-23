import { describe, expect, it } from "vitest";
import {
  createAuditProgressReporter,
  parseProgressArgs,
} from "../src/aggregator/audit-cli.js";
import type { AuditExportProgress } from "../src/aggregator/council-audit.js";

function progress(over: Partial<AuditExportProgress> = {}): AuditExportProgress {
  return { records: 0, bytes: 0, elapsedMs: 0, done: false, ...over };
}

describe("parseProgressArgs", () => {
  it("enables progress by default so a long export is not silent", () => {
    expect(parseProgressArgs([])).toBe(true);
  });

  it("supports --no-progress for scripts that require an empty stderr", () => {
    expect(parseProgressArgs(["--no-progress"])).toBe(false);
  });

  it("lets the last progress flag win", () => {
    expect(parseProgressArgs(["--no-progress", "--progress"])).toBe(true);
    expect(parseProgressArgs(["--progress", "--no-progress"])).toBe(false);
  });
});

describe("createAuditProgressReporter", () => {
  function reporterWithLines(intervalMs = 1_000): { lines: string[]; report: (p: AuditExportProgress) => void } {
    const lines: string[] = [];
    const stream = {
      write: (chunk: string) => {
        lines.push(chunk);
        return true;
      },
    };
    return {
      lines,
      report: createAuditProgressReporter({ format: "csv", stream, intervalMs }),
    };
  }

  it("throttles in-flight updates but always writes the final summary", () => {
    const { lines, report } = reporterWithLines(1_000);

    report(progress());
    report(progress({ records: 5, bytes: 100, elapsedMs: 500 }));
    report(progress({ records: 10, bytes: 200, elapsedMs: 1_000 }));
    report(progress({ records: 12, bytes: 240, elapsedMs: 1_200, done: true }));

    // Start line, the update due at 1s, and the final line. The 500ms update is
    // skipped so a fast export does not flood the log.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("csv");
    expect(lines[0]).toContain("0 records");
    expect(lines[1]).toContain("10 records");
    expect(lines[2]).toContain("complete: 12 records");
    expect(lines[2]).toContain("1.2s");
  });

  it("uses singular wording for a single record and human-readable sizes", () => {
    const { lines, report } = reporterWithLines();

    report(progress({ records: 1, bytes: 1_536, elapsedMs: 0, done: true }));

    expect(lines[0]).toContain("1 record,");
    expect(lines[0]).toContain("1.5 KiB");
  });
});
