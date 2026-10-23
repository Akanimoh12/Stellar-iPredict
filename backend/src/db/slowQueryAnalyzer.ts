import readline from "node:readline";
import type { Readable } from "node:stream";

/**
 * Raw slow query observation extracted from a single log entry.
 */
export interface RawSlowQueryEntry {
  /** Parameterized or raw SQL statement text. */
  query: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Optional timestamp or metadata from the log line. */
  timestamp?: string;
}

/**
 * Aggregated statistical summary for a single normalized query shape.
 */
export interface QueryShapeStats {
  /** Canonical query shape with literals and parameters masked. */
  shape: string;
  /** Total number of observed executions for this shape. */
  count: number;
  /** Cumulative execution time across all calls in milliseconds. */
  totalTimeMs: number;
  /** Arithmetic mean execution time in milliseconds. */
  meanMs: number;
  /** Fastest observed execution time in milliseconds. */
  minMs: number;
  /** Slowest observed execution time in milliseconds. */
  maxMs: number;
  /** 50th percentile (median) duration in milliseconds. */
  p50Ms: number;
  /** 90th percentile duration in milliseconds. */
  p90Ms: number;
  /** 95th percentile duration in milliseconds. */
  p95Ms: number;
  /** 99th percentile duration in milliseconds. */
  p99Ms: number;
  /** Percentage of global cumulative query time consumed by this shape. */
  percentTotalTime: number;
  /** A representative raw query instance for quick debugging. */
  exampleQuery: string;
}

/**
 * Full aggregated analysis report across all ingested slow query logs.
 */
export interface SlowQueryAnalysisReport {
  /** Total raw log lines parsed (valid and invalid). */
  totalLinesProcessed: number;
  /** Total slow query occurrences extracted. */
  totalSlowQueries: number;
  /** Number of distinct normalized query shapes discovered. */
  uniqueShapes: number;
  /** Cumulative execution time across all slow queries in milliseconds. */
  totalTimeMs: number;
  /** Aggregated query shapes ranked in descending order of totalTimeMs. */
  stats: QueryShapeStats[];
  /** Top-tier optimization targets accounting for >=80% of cumulative time (Pareto principle). */
  highValueTargets: QueryShapeStats[];
}

/**
 * Configuration options for log analysis filtering.
 */
export interface AnalysisOptions {
  /** Minimum single-query duration threshold in ms to include (default: 0). */
  minDurationMs?: number;
  /** Minimum total call count for a query shape to be included (default: 1). */
  minCalls?: number;
  /** Maximum number of top shapes to return in ranked results (default: undefined = all). */
  top?: number;
}

/**
 * Parsed command-line arguments for the slow query analysis CLI.
 */
export interface CliArgs {
  filePath?: string;
  top?: number;
  minDurationMs?: number;
  minCalls?: number;
  json: boolean;
  csv: boolean;
  help: boolean;
}

export const USAGE = `
iPredict — Slow Query Log Analyzer

Usage:
  npx tsx scripts/analyze-slow-queries.ts [options]
  cat logs.jsonl | npx tsx scripts/analyze-slow-queries.ts [options]

Options:
  -f, --file <path>        Path to log file (default: reads from stdin)
  -n, --top <number>       Number of top ranked query shapes to display (default: 10)
  --min-duration <ms>      Filter out individual queries faster than this duration in ms
  --min-calls <number>     Filter out query shapes with fewer than N calls (default: 1)
  --json                   Output complete report as JSON (suitable for tooling / CI)
  --csv                    Output aggregated shapes as CSV
  -h, --help               Show this help message

Ranking Metric:
  Queries are ranked strictly by TOTAL TIME CONSUMED (Cumulative Workload Impact),
  not by single worst execution. This identifies the highest-value optimization targets.

Examples:
  # Piped from docker compose logs
  docker compose logs backend | npx tsx scripts/analyze-slow-queries.ts

  # Piped from Fluent-bit log files
  cat /var/log/ipredict/containers.log | npx tsx scripts/analyze-slow-queries.ts --top 5

  # Analyze specific file with CSV export
  npx tsx scripts/analyze-slow-queries.ts -f logs.txt --csv > report.csv
`.trim();

/**
 * Parses raw command-line arguments into structured CliArgs.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    top: 10,
    json: false,
    csv: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-f" || arg === "--file") {
      args.filePath = argv[++i];
    } else if (arg === "-n" || arg === "--top") {
      const val = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(val) && val > 0) args.top = val;
    } else if (arg === "--min-duration") {
      const val = Number.parseFloat(argv[++i] ?? "");
      if (Number.isFinite(val) && val >= 0) args.minDurationMs = val;
    } else if (arg === "--min-calls") {
      const val = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(val) && val >= 1) args.minCalls = val;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--csv") {
      args.csv = true;
    }
  }

  return args;
}

/**
 * Normalizes an arbitrary SQL query into a canonical query shape.
 *
 * Transformations applied:
 * 1. String literals ('...') replaced with '?' (handling escaped single quotes).
 * 2. Hexadecimal constants (0x...) replaced with '?'.
 * 3. Numeric literals (integers, floats, exponents) replaced with '?'.
 * 4. PostgreSQL parameter placeholders ($1, $2, ...) normalized to '?'.
 * 5. Value lists in IN clauses, e.g. IN (?, ?, ?) collapsed to IN (?).
 * 6. Multi-row VALUES tuples, e.g. VALUES (?), (?) collapsed to VALUES (?).
 * 7. Whitespace, tabs, and newlines collapsed into single spaces and trimmed.
 *
 * @param query Raw or parameterized SQL statement.
 * @returns Canonical query shape.
 */
export function normalizeQueryShape(query: string): string {
  if (!query) return "";

  let normalized = query;

  // 1. Replace single-quoted string literals, accounting for escaped quotes ('' or \')
  normalized = normalized.replace(/'(?:''|\\'|[^'])*'/g, "'?'");

  // 2. Replace hexadecimal literals (e.g. 0x1a2b)
  normalized = normalized.replace(/\b0x[0-9a-fA-F]+\b/g, "?");

  // 3. Replace numeric literals (integers, floats, scientific notation)
  // Be careful not to replace column aliases or table names that end in numbers.
  normalized = normalized.replace(/(?<![a-zA-Z_#$])\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "?");

  // 4. Normalize PostgreSQL numbered parameters ($1, $2, ...) to '?'
  normalized = normalized.replace(/\$\d+/g, "?");

  // 5. Collapse IN (?) lists: IN (?, ?, ..., ?) -> IN (?)
  normalized = normalized.replace(/\bIN\s*\(\s*(?:(?:\?|'\?')\s*,\s*)*(?:\?|'\?')\s*\)/gi, "IN (?)");

  // 6. Collapse multi-value lists in VALUES: VALUES (?), (?) -> VALUES (?)
  normalized = normalized.replace(
    /\bVALUES\s*\(\s*(?:\?\s*,\s*)*\?\s*\)(?:\s*,\s*\(\s*(?:\?\s*,\s*)*\?\s*\))*/gi,
    "VALUES (?)",
  );

  // 7. Collapse all contiguous whitespace / newlines into a single space
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Parses a single line of log output into a structured slow query entry.
 *
 * Supports:
 * - Application JSON logs (Pino / Fastify / logSlowQuery):
 *   `{"level":"warn","msg":"slow db query","durationMs":245.3,"query":"SELECT ..."}`
 * - PostgreSQL engine log_min_duration_statement logs:
 *   `2026-10-22 00:00:00 UTC [1234]: LOG:  duration: 245.300 ms  statement: SELECT ...`
 *   or `duration: 245.3 ms execute <unnamed>: SELECT ...`
 *
 * @param line Single raw log line.
 * @returns RawSlowQueryEntry if recognized, or null if line is not a slow query log.
 */
export function parseLogLine(line: string): RawSlowQueryEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Attempt 1: JSON Application Log
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Match logSlowQuery format: msg === "slow db query" or general slow query JSON keys
      const isSlowQueryMsg =
        parsed.msg === "slow db query" ||
        parsed.message === "slow db query" ||
        (typeof parsed.query === "string" && typeof parsed.durationMs === "number");

      if (isSlowQueryMsg && typeof parsed.query === "string") {
        const durationMs =
          typeof parsed.durationMs === "number"
            ? parsed.durationMs
            : typeof parsed.duration === "number"
              ? parsed.duration
              : typeof parsed.durationMs === "string"
                ? Number.parseFloat(parsed.durationMs)
                : 0;

        if (Number.isFinite(durationMs) && durationMs >= 0) {
          return {
            query: parsed.query,
            durationMs,
            timestamp: typeof parsed.time === "string" ? parsed.time : undefined,
          };
        }
      }
    } catch {
      // Not valid JSON, fall through to regex parser
    }
  }

  // Attempt 2: Standard PostgreSQL engine log (log_min_duration_statement)
  // Example: "LOG:  duration: 245.300 ms  statement: SELECT * FROM markets"
  // Example: "LOG:  duration: 120.450 ms  execute <unnamed>: SELECT * FROM markets WHERE id = $1"
  const pgEngineRegex =
    /duration:\s*([\d.]+)\s*ms\s+(?:statement|execute\s*(?:<[^>]+>)?):\s*([\s\S]+)$/i;
  const pgMatch = pgEngineRegex.exec(trimmed);
  if (pgMatch && pgMatch[1] && pgMatch[2]) {
    const durationMs = Number.parseFloat(pgMatch[1]);
    const query = pgMatch[2].trim();
    if (Number.isFinite(durationMs) && durationMs >= 0 && query.length > 0) {
      return {
        query,
        durationMs,
      };
    }
  }

  return null;
}

/**
 * Computes the p-th percentile from a sorted numeric array using linear interpolation.
 *
 * @param sortedValues Array of numbers sorted in ascending order.
 * @param p Desired percentile between 0 and 100.
 * @returns Interpolated value at percentile p.
 */
export function calculatePercentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;

  const clampedP = Math.max(0, Math.min(100, p));
  const rank = (clampedP / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const weight = rank - lowerIndex;

  const lowerValue = sortedValues[lowerIndex]!;
  const upperValue = sortedValues[upperIndex]!;

  return lowerValue * (1 - weight) + upperValue * weight;
}

/**
 * In-memory accumulator used during query aggregation.
 */
interface ShapeAccumulator {
  shape: string;
  // Fixed-size reservoir keeps percentile memory bounded per shape.
  durations: number[];
  seen: number;
  totalTimeMs: number;
  minMs: number;
  maxMs: number;
  exampleQuery: string;
}

/**
 * Aggregates a list of raw slow query entries into a comprehensive statistical report.
 * Ranks all shapes primarily by total time consumed in descending order.
 *
 * @param entries List of extracted raw slow query entries.
 * @param options Filtering and top-k options.
 * @returns SlowQueryAnalysisReport.
 */
export function analyzeSlowQueries(
  entries: readonly RawSlowQueryEntry[],
  options: AnalysisOptions = {},
): SlowQueryAnalysisReport {
  const minDurationMs = options.minDurationMs ?? 0;
  const minCalls = options.minCalls ?? 1;

  const map = new Map<string, ShapeAccumulator>();
  let totalSlowQueries = 0;
  let globalTotalTimeMs = 0;

  for (const entry of entries) {
    if (entry.durationMs < minDurationMs) {
      continue;
    }

    const shape = normalizeQueryShape(entry.query);
    if (!shape) continue;

    totalSlowQueries++;
    globalTotalTimeMs += entry.durationMs;

    let acc = map.get(shape);
    if (!acc) {
      acc = {
        shape,
        durations: [],
        seen: 0,
        totalTimeMs: 0,
        minMs: entry.durationMs,
        maxMs: entry.durationMs,
        exampleQuery: entry.query,
      };
      map.set(shape, acc);
    }

    addDuration(acc, entry.durationMs);
    acc.totalTimeMs += entry.durationMs;
    if (entry.durationMs < acc.minMs) acc.minMs = entry.durationMs;
    if (entry.durationMs > acc.maxMs) acc.maxMs = entry.durationMs;
  }

  // Calculate statistics for each shape
  const statsList: QueryShapeStats[] = [];

  for (const acc of map.values()) {
    if (acc.seen < minCalls) {
      continue;
    }

    // Sort durations ascending for exact percentile calculation
    acc.durations.sort((a, b) => a - b);
    const count = acc.seen;
    const meanMs = count > 0 ? acc.totalTimeMs / count : 0;
    const percentTotalTime =
      globalTotalTimeMs > 0 ? (acc.totalTimeMs / globalTotalTimeMs) * 100 : 0;

    statsList.push({
      shape: acc.shape,
      count,
      totalTimeMs: Math.round(acc.totalTimeMs * 100) / 100,
      meanMs: Math.round(meanMs * 100) / 100,
      minMs: Math.round(acc.minMs * 100) / 100,
      maxMs: Math.round(acc.maxMs * 100) / 100,
      p50Ms: Math.round(calculatePercentile(acc.durations, 50) * 100) / 100,
      p90Ms: Math.round(calculatePercentile(acc.durations, 90) * 100) / 100,
      p95Ms: Math.round(calculatePercentile(acc.durations, 95) * 100) / 100,
      p99Ms: Math.round(calculatePercentile(acc.durations, 99) * 100) / 100,
      percentTotalTime: Math.round(percentTotalTime * 10) / 10,
      exampleQuery: acc.exampleQuery,
    });
  }

  // Primary ranking: strictly by totalTimeMs descending (highest cumulative consumption first)
  statsList.sort((a, b) => b.totalTimeMs - a.totalTimeMs);

  // Identify high-value optimization targets using the Pareto principle (cumulative 80% time)
  const highValueTargets: QueryShapeStats[] = [];
  let cumulativeTimeMs = 0;
  const eightyPercentThreshold = globalTotalTimeMs * 0.8;

  for (const stat of statsList) {
    if (cumulativeTimeMs < eightyPercentThreshold || highValueTargets.length === 0) {
      highValueTargets.push(stat);
      cumulativeTimeMs += stat.totalTimeMs;
    } else {
      break;
    }
  }

  const finalStats = options.top !== undefined ? statsList.slice(0, options.top) : statsList;

  return {
    totalLinesProcessed: entries.length,
    totalSlowQueries,
    uniqueShapes: statsList.length,
    totalTimeMs: Math.round(globalTotalTimeMs * 100) / 100,
    stats: finalStats,
    highValueTargets,
  };
}

const PERCENTILE_RESERVOIR_SIZE = 4096;

function addDuration(acc: ShapeAccumulator, durationMs: number): void {
  acc.seen++;
  if (acc.durations.length < PERCENTILE_RESERVOIR_SIZE) {
    acc.durations.push(durationMs);
  } else {
    const slot = Math.floor(Math.random() * acc.seen);
    if (slot < PERCENTILE_RESERVOIR_SIZE) acc.durations[slot] = durationMs;
  }
}

/**
 * Streams log lines from a Readable stream (e.g. stdin or file stream) and aggregates them.
 * Memory efficient: processes lines one-by-one without buffering the entire input file.
 *
 * @param stream Node.js Readable stream.
 * @param options Filtering and ranking options.
 * @returns Promise resolving to SlowQueryAnalysisReport.
 */
export async function analyzeLogStream(
  stream: Readable,
  options: AnalysisOptions = {},
): Promise<SlowQueryAnalysisReport> {
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const aggregates = new Map<string, ShapeAccumulator>();
  let totalSlowQueries = 0;
  let totalTimeMs = 0;
  let totalLinesProcessed = 0;

  for await (const line of rl) {
    totalLinesProcessed++;
    const entry = parseLogLine(line);
    if (!entry || entry.durationMs < (options.minDurationMs ?? 0)) continue;
    const shape = normalizeQueryShape(entry.query);
    if (!shape) continue;
    totalSlowQueries++;
    totalTimeMs += entry.durationMs;
    let acc = aggregates.get(shape);
    if (!acc) {
      acc = { shape, durations: [], seen: 0, totalTimeMs: 0, minMs: entry.durationMs, maxMs: entry.durationMs, exampleQuery: entry.query };
      aggregates.set(shape, acc);
    }
    addDuration(acc, entry.durationMs);
    acc.totalTimeMs += entry.durationMs;
    acc.minMs = Math.min(acc.minMs, entry.durationMs);
    acc.maxMs = Math.max(acc.maxMs, entry.durationMs);
  }

  const report = buildReport(aggregates, totalSlowQueries, totalTimeMs, totalLinesProcessed, options);
  return report;
}

function buildReport(map: Map<string, ShapeAccumulator>, totalSlowQueries: number, globalTotalTimeMs: number, totalLinesProcessed: number, options: AnalysisOptions): SlowQueryAnalysisReport {
  const minCalls = options.minCalls ?? 1;
  const statsList: QueryShapeStats[] = [];
  for (const acc of map.values()) {
    if (acc.seen < minCalls) continue;
    acc.durations.sort((a, b) => a - b);
    const count = acc.seen;
    const meanMs = acc.totalTimeMs / count;
    statsList.push({
      shape: acc.shape, count, totalTimeMs: Math.round(acc.totalTimeMs * 100) / 100,
      meanMs: Math.round(meanMs * 100) / 100, minMs: Math.round(acc.minMs * 100) / 100,
      maxMs: Math.round(acc.maxMs * 100) / 100,
      p50Ms: Math.round(calculatePercentile(acc.durations, 50) * 100) / 100,
      p90Ms: Math.round(calculatePercentile(acc.durations, 90) * 100) / 100,
      p95Ms: Math.round(calculatePercentile(acc.durations, 95) * 100) / 100,
      p99Ms: Math.round(calculatePercentile(acc.durations, 99) * 100) / 100,
      percentTotalTime: globalTotalTimeMs > 0 ? Math.round((acc.totalTimeMs / globalTotalTimeMs) * 1000) / 10 : 0,
      exampleQuery: acc.exampleQuery,
    });
  }
  statsList.sort((a, b) => b.totalTimeMs - a.totalTimeMs);
  const highValueTargets: QueryShapeStats[] = [];
  let cumulativeTimeMs = 0;
  for (const stat of statsList) {
    if (cumulativeTimeMs < globalTotalTimeMs * 0.8 || highValueTargets.length === 0) {
      highValueTargets.push(stat);
      cumulativeTimeMs += stat.totalTimeMs;
    } else break;
  }
  const finalStats = options.top !== undefined ? statsList.slice(0, options.top) : statsList;
  return {
    totalLinesProcessed,
    totalSlowQueries,
    uniqueShapes: statsList.length,
    totalTimeMs: Math.round(globalTotalTimeMs * 100) / 100,
    stats: finalStats,
    highValueTargets,
  };
}

/**
 * Formats the analysis report as a clear, human-readable terminal table.
 *
 * @param report Aggregated analysis report.
 * @param topCount Optional limit of rows to display.
 * @returns Formatted multi-line string.
 */
export function formatTextReport(report: SlowQueryAnalysisReport, topCount?: number): string {
  const lines: string[] = [];

  lines.push("================================================================================");
  lines.push("                       SLOW QUERY LOG ANALYSIS REPORT                          ");
  lines.push("================================================================================");
  lines.push(`Total Log Lines Processed : ${report.totalLinesProcessed.toLocaleString()}`);
  lines.push(`Total Slow Queries Found  : ${report.totalSlowQueries.toLocaleString()}`);
  lines.push(`Unique Query Shapes       : ${report.uniqueShapes.toLocaleString()}`);
  lines.push(`Cumulative Database Time  : ${(report.totalTimeMs / 1000).toFixed(2)}s (${report.totalTimeMs.toLocaleString()} ms)`);
  lines.push("Ranking Metric            : TOTAL TIME CONSUMED (Cumulative Workload Impact)");
  lines.push("================================================================================");
  lines.push("");

  const displayList = topCount !== undefined ? report.stats.slice(0, topCount) : report.stats;

  if (displayList.length === 0) {
    lines.push("No slow queries observed matching the specified criteria.");
    return lines.join("\n");
  }

  lines.push("RANKED OPTIMIZATION TARGETS:");
  lines.push("--------------------------------------------------------------------------------");

  let rank = 1;
  for (const s of displayList) {
    const isPareto = report.highValueTargets.some((h) => h.shape === s.shape);
    const paretoBadge = isPareto ? " [HIGH IMPACT - TOP 80% CUMULATIVE TIME]" : "";

    lines.push(
      `#${rank} | Total Time: ${(s.totalTimeMs / 1000).toFixed(2)}s (${s.percentTotalTime}% of DB time) | Calls: ${s.count}${paretoBadge}`,
    );
    lines.push(
      `    Mean: ${s.meanMs.toFixed(1)}ms | Min: ${s.minMs.toFixed(1)}ms | Max: ${s.maxMs.toFixed(1)}ms`,
    );
    lines.push(
      `    Percentiles: p50: ${s.p50Ms.toFixed(1)}ms | p90: ${s.p90Ms.toFixed(1)}ms | p95: ${s.p95Ms.toFixed(1)}ms | p99: ${s.p99Ms.toFixed(1)}ms`,
    );
    lines.push(`    Shape: ${s.shape}`);
    lines.push("");
    rank++;
  }

  lines.push("================================================================================");
  lines.push("RECOMMENDED NEXT ACTIONS:");
  lines.push("--------------------------------------------------------------------------------");
  if (report.highValueTargets.length > 0) {
    lines.push(
      `* Focus optimization on the top ${report.highValueTargets.length} query shape(s) above.`,
    );
    lines.push(
      "* High Calls + Low/Moderate Mean: Potential N+1 query problem or missing Redis cache-aside.",
    );
    lines.push(
      "* Low Calls + High Max/p99: Potential missing partial/sort index or sequential table scan.",
    );
    lines.push(
      "* Run EXPLAIN (ANALYZE, BUFFERS) against the shape's example query in local psql.",
    );
  } else {
    lines.push("* All queries are within acceptable performance thresholds.");
  }
  lines.push("================================================================================");

  return lines.join("\n");
}

/**
 * Formats the analysis report as comma-separated values (CSV).
 *
 * @param report Aggregated analysis report.
 * @param topCount Optional limit of rows to export.
 * @returns CSV string.
 */
export function formatCsvReport(report: SlowQueryAnalysisReport, topCount?: number): string {
  const displayList = topCount !== undefined ? report.stats.slice(0, topCount) : report.stats;

  const headers = [
    "rank",
    "total_time_ms",
    "percent_total_time",
    "calls",
    "mean_ms",
    "min_ms",
    "max_ms",
    "p50_ms",
    "p90_ms",
    "p95_ms",
    "p99_ms",
    "is_high_impact_target",
    "query_shape",
  ];

  const rows = [headers.join(",")];

  let rank = 1;
  for (const s of displayList) {
    const isPareto = report.highValueTargets.some((h) => h.shape === s.shape);
    const escapedShape = `"${s.shape.replace(/"/g, '""')}"`;

    rows.push(
      [
        rank,
        s.totalTimeMs,
        s.percentTotalTime,
        s.count,
        s.meanMs,
        s.minMs,
        s.maxMs,
        s.p50Ms,
        s.p90Ms,
        s.p95Ms,
        s.p99Ms,
        isPareto ? "true" : "false",
        escapedShape,
      ].join(","),
    );
    rank++;
  }

  return rows.join("\n");
}
