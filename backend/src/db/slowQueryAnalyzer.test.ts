import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  analyzeLogStream,
  analyzeSlowQueries,
  calculatePercentile,
  formatCsvReport,
  formatTextReport,
  normalizeQueryShape,
  parseCliArgs,
  parseLogLine,
  type RawSlowQueryEntry,
} from "./slowQueryAnalyzer.js";

describe("normalizeQueryShape", () => {
  it("normalizes single-quoted string literals to '?'", () => {
    const raw = "SELECT * FROM markets WHERE category = 'Crypto' AND creator = 'GABCD1234'";
    const normalized = normalizeQueryShape(raw);
    expect(normalized).toBe("SELECT * FROM markets WHERE category = '?' AND creator = '?'");
  });

  it("handles escaped single quotes inside strings", () => {
    const raw = "SELECT * FROM markets WHERE question = 'Will it rain today? It''s cloudy'";
    const normalized = normalizeQueryShape(raw);
    expect(normalized).toBe("SELECT * FROM markets WHERE question = '?'");
  });

  it("normalizes numeric constants (integers, decimals, scientific)", () => {
    const raw = "SELECT * FROM bets WHERE net_amount > 10000000 AND gross_amount <= 25000000.50";
    const normalized = normalizeQueryShape(raw);
    expect(normalized).toBe("SELECT * FROM bets WHERE net_amount > ? AND gross_amount <= ?");
  });

  it("normalizes postgres parameter placeholders ($1, $2, $3...)", () => {
    const raw = "SELECT * FROM markets WHERE id = $1 AND resolved = $2 AND category = $3";
    const normalized = normalizeQueryShape(raw);
    expect(normalized).toBe("SELECT * FROM markets WHERE id = ? AND resolved = ? AND category = ?");
  });

  it("collapses IN (...) lists of parameters or literals to IN (?)", () => {
    const rawWithParams = "SELECT * FROM markets WHERE id IN ($1, $2, $3, $4)";
    expect(normalizeQueryShape(rawWithParams)).toBe("SELECT * FROM markets WHERE id IN (?)");

    const rawWithLiterals = "SELECT * FROM markets WHERE category IN ('Crypto', 'Sports', 'Science')";
    expect(normalizeQueryShape(rawWithLiterals)).toBe("SELECT * FROM markets WHERE category IN (?)");
  });

  it("collapses multi-row VALUES clauses to VALUES (?)", () => {
    const raw = "INSERT INTO token_balances (address, amount) VALUES ($1, $2), ($3, $4), ($5, $6)";
    expect(normalizeQueryShape(raw)).toBe(
      "INSERT INTO token_balances (address, amount) VALUES (?)",
    );
  });

  it("collapses multiple consecutive spaces, tabs, and newlines into a single space", () => {
    const raw = `
      SELECT
        id,   question,
        total_yes
      FROM   markets
      WHERE  id = $1
    `;
    expect(normalizeQueryShape(raw)).toBe(
      "SELECT id, question, total_yes FROM markets WHERE id = ?",
    );
  });

  it("returns empty string for empty input", () => {
    expect(normalizeQueryShape("")).toBe("");
  });
});

describe("parseLogLine", () => {
  it("parses application JSON slow query logs (logSlowQuery)", () => {
    const jsonLine = JSON.stringify({
      level: "warn",
      msg: "slow db query",
      durationMs: 245.3,
      thresholdMs: 200,
      query: "SELECT * FROM markets WHERE id = $1",
    });

    const parsed = parseLogLine(jsonLine);
    expect(parsed).toEqual({
      query: "SELECT * FROM markets WHERE id = $1",
      durationMs: 245.3,
      timestamp: undefined,
    });
  });

  it("parses application JSON logs with timestamp and message", () => {
    const jsonLine = JSON.stringify({
      time: "2026-10-22T00:15:30.000Z",
      level: 40,
      msg: "slow db query",
      durationMs: 310.8,
      query: "SELECT * FROM bets WHERE market_id = $1",
    });

    const parsed = parseLogLine(jsonLine);
    expect(parsed).toEqual({
      query: "SELECT * FROM bets WHERE market_id = $1",
      durationMs: 310.8,
      timestamp: "2026-10-22T00:15:30.000Z",
    });
  });

  it("parses PostgreSQL engine log_min_duration_statement logs", () => {
    const pgLine =
      "2026-10-22 00:15:30.123 UTC [1234]: LOG:  duration: 345.670 ms  statement: SELECT * FROM markets WHERE category = 'Crypto'";
    const parsed = parseLogLine(pgLine);
    expect(parsed).toEqual({
      query: "SELECT * FROM markets WHERE category = 'Crypto'",
      durationMs: 345.67,
    });
  });

  it("parses PostgreSQL execute <unnamed> statements", () => {
    const pgExecuteLine =
      "LOG: duration: 180.200 ms execute <unnamed>: SELECT * FROM leaderboard WHERE address = $1";
    const parsed = parseLogLine(pgExecuteLine);
    expect(parsed).toEqual({
      query: "SELECT * FROM leaderboard WHERE address = $1",
      durationMs: 180.2,
    });
  });

  it("returns null for non-slow-query log lines or malformed text", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("   ")).toBeNull();
    expect(parseLogLine("2026-10-22 00:00:00 [info] server listening on 0.0.0.0:4000")).toBeNull();
    expect(parseLogLine(JSON.stringify({ level: "info", msg: "request completed" }))).toBeNull();
    expect(parseLogLine("{ invalid json }")).toBeNull();
  });
});

describe("calculatePercentile", () => {
  it("handles empty and single-element arrays", () => {
    expect(calculatePercentile([], 50)).toBe(0);
    expect(calculatePercentile([100], 90)).toBe(100);
  });

  it("accurately calculates median and percentiles on sorted values", () => {
    const values = [10, 20, 30, 40, 50]; // 5 values: indices 0 to 4
    expect(calculatePercentile(values, 0)).toBe(10);
    expect(calculatePercentile(values, 50)).toBe(30); // Rank = 0.5 * 4 = 2 -> values[2] = 30
    expect(calculatePercentile(values, 100)).toBe(50);
  });

  it("performs linear interpolation between adjacent ranks", () => {
    const values = [100, 200]; // 2 values: index 0 and 1
    // p = 50 -> rank = 0.5 * 1 = 0.5 -> 100 * 0.5 + 200 * 0.5 = 150
    expect(calculatePercentile(values, 50)).toBe(150);
    expect(calculatePercentile(values, 25)).toBe(125);
    expect(calculatePercentile(values, 75)).toBe(175);
  });
});

describe("analyzeSlowQueries", () => {
  it("ranks queries strictly by TOTAL TIME consumed, not worst single execution", () => {
    // Query A: 1000 calls x 250 ms = 250,000 ms total (Worst single execution = 300 ms)
    // Query B: 1 call x 5000 ms = 5,000 ms total (Worst single execution = 5000 ms)
    const entries: RawSlowQueryEntry[] = [];

    for (let i = 0; i < 1000; i++) {
      entries.push({
        query: `SELECT * FROM markets WHERE id = ${i}`,
        durationMs: i === 0 ? 300 : 250,
      });
    }

    entries.push({
      query: "SELECT * FROM events WHERE payload @> '{\"test\": true}'",
      durationMs: 5000,
    });

    const report = analyzeSlowQueries(entries);

    expect(report.uniqueShapes).toBe(2);
    expect(report.stats).toHaveLength(2);

    // Rank #1 MUST be Query A (total time ~250,050 ms), NOT Query B (5000 ms)
    const rank1 = report.stats[0]!;
    const rank2 = report.stats[1]!;

    expect(rank1.shape).toBe("SELECT * FROM markets WHERE id = ?");
    expect(rank1.count).toBe(1000);
    expect(rank1.totalTimeMs).toBeGreaterThan(250000);
    expect(rank1.maxMs).toBe(300);

    expect(rank2.shape).toBe("SELECT * FROM events WHERE payload @> '?'");
    expect(rank2.count).toBe(1);
    expect(rank2.totalTimeMs).toBe(5000);
    expect(rank2.maxMs).toBe(5000);
  });

  it("calculates accurate mean, min, max, and percentiles per shape", () => {
    const entries: RawSlowQueryEntry[] = [
      { query: "SELECT * FROM bets WHERE market_id = 1", durationMs: 100 },
      { query: "SELECT * FROM bets WHERE market_id = 2", durationMs: 200 },
      { query: "SELECT * FROM bets WHERE market_id = 3", durationMs: 300 },
      { query: "SELECT * FROM bets WHERE market_id = 4", durationMs: 400 },
      { query: "SELECT * FROM bets WHERE market_id = 5", durationMs: 500 },
    ];

    const report = analyzeSlowQueries(entries);
    expect(report.stats).toHaveLength(1);

    const s = report.stats[0]!;
    expect(s.count).toBe(5);
    expect(s.totalTimeMs).toBe(1500);
    expect(s.meanMs).toBe(300);
    expect(s.minMs).toBe(100);
    expect(s.maxMs).toBe(500);
    expect(s.p50Ms).toBe(300);
    expect(s.percentTotalTime).toBe(100);
  });

  it("identifies high-value optimization targets using the 80/20 Pareto principle", () => {
    const entries: RawSlowQueryEntry[] = [
      // Target 1: 85% of total time
      { query: "SELECT * FROM markets", durationMs: 850 },
      // Target 2: 10% of total time
      { query: "SELECT * FROM bets", durationMs: 100 },
      // Target 3: 5% of total time
      { query: "SELECT * FROM leaderboard", durationMs: 50 },
    ];

    const report = analyzeSlowQueries(entries);
    expect(report.highValueTargets).toHaveLength(1);
    expect(report.highValueTargets[0]?.shape).toBe("SELECT * FROM markets");
  });

  it("respects minDurationMs, minCalls, and top options", () => {
    const entries: RawSlowQueryEntry[] = [
      { query: "SELECT 1", durationMs: 50 },
      { query: "SELECT 2", durationMs: 250 },
      { query: "SELECT 3", durationMs: 300 },
      { query: "SELECT 4", durationMs: 350 },
    ];

    const filtered = analyzeSlowQueries(entries, { minDurationMs: 200, top: 2 });
    expect(filtered.totalSlowQueries).toBe(3); // 50ms skipped
    expect(filtered.stats).toHaveLength(2); // Top 2
  });
});

describe("analyzeLogStream", () => {
  it("streams lines from Readable and produces the aggregated report", async () => {
    const lines = [
      JSON.stringify({ msg: "slow db query", durationMs: 210, query: "SELECT * FROM markets WHERE id = 1" }),
      JSON.stringify({ msg: "slow db query", durationMs: 220, query: "SELECT * FROM markets WHERE id = 2" }),
      "ignored non-slow log line",
      "2026-10-22 00:00:00 UTC: LOG:  duration: 400.000 ms  statement: SELECT * FROM bets WHERE bettor = 'GABC'",
    ].join("\n");

    const stream = Readable.from([lines]);
    const report = await analyzeLogStream(stream);

    expect(report.totalLinesProcessed).toBe(4);
    expect(report.totalSlowQueries).toBe(3);
    expect(report.uniqueShapes).toBe(2);
  });
});

describe("formatTextReport and formatCsvReport", () => {
  const sampleEntries: RawSlowQueryEntry[] = [
    { query: "SELECT * FROM markets WHERE id = 1", durationMs: 250 },
    { query: "SELECT * FROM markets WHERE id = 2", durationMs: 350 },
  ];

  it("generates a human-readable text report with summary and ranked targets", () => {
    const report = analyzeSlowQueries(sampleEntries);
    const text = formatTextReport(report);

    expect(text).toContain("SLOW QUERY LOG ANALYSIS REPORT");
    expect(text).toContain("TOTAL TIME CONSUMED");
    expect(text).toContain("SELECT * FROM markets WHERE id = ?");
    expect(text).toContain("Percentiles: p50:");
    expect(text).toContain("RECOMMENDED NEXT ACTIONS:");
  });

  it("generates CSV formatted output with proper columns", () => {
    const report = analyzeSlowQueries(sampleEntries);
    const csv = formatCsvReport(report);

    expect(csv).toContain("rank,total_time_ms,percent_total_time,calls,mean_ms,min_ms,max_ms,p50_ms,p90_ms,p95_ms,p99_ms,is_high_impact_target,query_shape");
    expect(csv).toContain('"SELECT * FROM markets WHERE id = ?"');
  });
});

describe("parseCliArgs", () => {
  it("defaults to reading from stdin with top=10", () => {
    const args = parseCliArgs([]);
    expect(args).toEqual({
      top: 10,
      json: false,
      csv: false,
      help: false,
    });
  });

  it("parses --file and -f options", () => {
    expect(parseCliArgs(["--file", "/tmp/slow.log"]).filePath).toBe("/tmp/slow.log");
    expect(parseCliArgs(["-f", "/var/log/slow.log"]).filePath).toBe("/var/log/slow.log");
  });

  it("parses --top, --min-duration, --min-calls, --json, and --csv flags", () => {
    const args = parseCliArgs([
      "-n", "5",
      "--min-duration", "250.5",
      "--min-calls", "3",
      "--json",
    ]);

    expect(args.top).toBe(5);
    expect(args.minDurationMs).toBe(250.5);
    expect(args.minCalls).toBe(3);
    expect(args.json).toBe(true);
    expect(args.csv).toBe(false);
  });

  it("parses help flags", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });
});
