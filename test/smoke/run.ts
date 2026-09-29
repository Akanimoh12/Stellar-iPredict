#!/usr/bin/env node
/**
 * Post-deployment smoke suite — CLI.
 *
 * Usage:
 *   npm run smoke -- --base-url https://api.example.com
 *   npm run smoke -- --base-url http://localhost:3000 --strict
 *   npm run smoke -- --base-url ... --oracle-api-key "$KEY"     # authenticated path too
 *   npm run smoke -- --list
 *
 * Exits non-zero when any check fails, so it can gate a deployment script.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runSmokeSuite, smokeChecks, type CheckContext, type SmokeCheck } from "./checks.js";

interface CliOptions {
  baseUrl?: string;
  oracleApiKey?: string;
  writeTargetMarketId?: string;
  timeoutMs: number;
  strict: boolean;
  list: boolean;
  includeWriteChecks: boolean;
  help: boolean;
}

const USAGE = `
Post-deployment smoke suite for iPredict.

  --base-url <url>        Origin under test, e.g. https://api.example.com
                          (default: $SMOKE_BASE_URL)
  --oracle-api-key <key>  Enables the authenticated submission checks. The key is
                          only ever used to prove that auth *rejects*; no
                          submission is accepted by this suite by default.
  --timeout-ms <ms>       Per-request timeout (default: 10000)
  --strict                Treat warnings as failures
  --list                  List the checks and exit
  --help                  Show this message

Write-path checks (opt-in, off unless both flags are supplied together):
  --allow-writes          Include the check that submits a real oracle outcome
  --write-market-id <id>  The dedicated smoke-test market to submit against
                          (required by --allow-writes)

Every check is read-only unless marked WRITES STATE. The suite is safe to run
against production.
`.trim();

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    timeoutMs: 10_000,
    strict: false,
    list: false,
    includeWriteChecks: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--base-url": options.baseUrl = next(); break;
      case "--oracle-api-key": options.oracleApiKey = next(); break;
      case "--timeout-ms": options.timeoutMs = Number(next()); break;
      case "--write-market-id": options.writeTargetMarketId = next(); break;
      case "--allow-writes": options.includeWriteChecks = true; break;
      case "--strict": options.strict = true; break;
      case "--list": options.list = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return options;
}

const SYMBOL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
  skip: "SKIP",
};

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Renders one check line, marking write-path checks so they cannot be missed. */
function formatOutcome(outcome: { title: string; writesState: boolean; result: { status: string; detail?: string } }): string {
  const marker = outcome.writesState ? " [WRITES STATE]" : "";
  const label = (SYMBOL[outcome.result.status] ?? outcome.result.status).padEnd(4);
  const detail = outcome.result.detail ? ` — ${outcome.result.detail}` : "";
  return `  ${label} ${outcome.title}${marker}${detail}`;
}

export function formatReport(
  baseUrl: string,
  result: Awaited<ReturnType<typeof runSmokeSuite>>,
): string {
  const lines: string[] = [];
  lines.push(`iPredict smoke suite — ${baseUrl}`);
  lines.push("");

  for (const outcome of result.outcomes) {
    lines.push(formatOutcome(outcome));
  }

  lines.push("");
  lines.push(
    `${result.passed} passed, ${result.failed} failed, ${result.warned} warning, ` +
      `${result.skipped} skipped in ${formatDuration(result.durationMs)}`,
  );

  if (result.failed > 0) {
    lines.push("");
    lines.push("This deployment does not look healthy. Do not proceed — see docs/DEPLOYMENT-GUIDE.md § Post-deployment smoke suite.");
  } else if (result.warned > 0) {
    lines.push("");
    lines.push("Usable, but read the warnings above before proceeding.");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    process.exit(2);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (options.list) {
    for (const check of smokeChecks({ includeWriteChecks: true }) as SmokeCheck[]) {
      console.log(`${check.writesState ? "WRITES STATE" : "read-only   "}  ${check.id.padEnd(28)} ${check.description}`);
    }
    return;
  }

  const baseUrl = (options.baseUrl ?? process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    console.error("No target supplied. Pass --base-url or set SMOKE_BASE_URL.");
    console.error(`\n${USAGE}`);
    process.exit(2);
  }

  if (options.includeWriteChecks && !options.writeTargetMarketId) {
    // Refused here rather than deep inside the check, so the operator sees it
    // before any request is made.
    console.error("--allow-writes requires --write-market-id naming a dedicated smoke-test market.");
    process.exit(2);
  }

  const context: CheckContext = {
    baseUrl,
    timeoutMs: options.timeoutMs,
    oracleApiKey: options.oracleApiKey ?? process.env.SMOKE_ORACLE_API_KEY,
    writeTargetMarketId: options.writeTargetMarketId,
    strict: options.strict,
  };

  if (options.includeWriteChecks) {
    console.log(
      "WARNING: --allow-writes is set. One check will attempt a real oracle submission " +
        `against market ${options.writeTargetMarketId}.`,
    );
  }

  const result = await runSmokeSuite(context, { includeWriteChecks: options.includeWriteChecks });
  console.log(formatReport(baseUrl, result));
  process.exit(result.exitCode);
}

// Only run when invoked directly, so the module can be imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error("smoke suite crashed:", error);
    process.exit(3);
  });
}
