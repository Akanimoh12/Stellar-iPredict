#!/usr/bin/env node
/**
 * Slow Query Log Analysis Script (#599)
 *
 * Ingests application and database slow query logs, normalizes statements into
 * canonical query shapes, and aggregates them by total execution time consumed
 * (identifying the highest-value optimization targets).
 *
 * Usage:
 *   # Analyze live production container logs via pipe:
 *   docker compose logs backend | npx tsx scripts/analyze-slow-queries.ts
 *
 *   # Analyze a log file:
 *   npx tsx scripts/analyze-slow-queries.ts --file /var/log/ipredict/backend.log
 *
 *   # Show top 5 targets in JSON format:
 *   npx tsx scripts/analyze-slow-queries.ts -f backend.log --top 5 --json
 *
 *   # Export as CSV:
 *   npx tsx scripts/analyze-slow-queries.ts -f backend.log --csv > slow_queries.csv
 */

import fs from "node:fs";
import process from "node:process";
import {
  analyzeLogStream,
  formatCsvReport,
  formatTextReport,
  parseCliArgs,
  USAGE,
  type AnalysisOptions,
  type CliArgs,
} from "../backend/src/db/slowQueryAnalyzer.js";

export { parseCliArgs };

export async function runCli(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (args.json && args.csv) {
    console.error("Error: choose either --json or --csv, not both.");
    process.exit(2);
  }

  let inputStream: NodeJS.ReadableStream;

  if (args.filePath) {
    if (!fs.existsSync(args.filePath)) {
      console.error(`Error: Log file not found at "${args.filePath}"`);
      process.exit(1);
    }
    inputStream = fs.createReadStream(args.filePath, { encoding: "utf8" });
  } else {
    // If standard input is an interactive terminal and no file is provided, print usage
    if (process.stdin.isTTY) {
      console.log(USAGE);
      process.exit(0);
    }
    inputStream = process.stdin;
  }

  const options: AnalysisOptions = {
    top: args.top,
    minDurationMs: args.minDurationMs,
    minCalls: args.minCalls,
  };

  try {
    const report = await analyzeLogStream(inputStream as import("node:stream").Readable, options);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (args.csv) {
      console.log(formatCsvReport(report, args.top));
    } else {
      console.log(formatTextReport(report, args.top));
    }
  } catch (error) {
    console.error("Fatal error during log analysis:", error);
    process.exit(1);
  }
}

// Auto-run when executed directly from CLI
if (process.argv[1]?.endsWith("analyze-slow-queries.ts")) {
  runCli().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
