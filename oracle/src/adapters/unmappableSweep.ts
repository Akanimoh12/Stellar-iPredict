#!/usr/bin/env node
/**
 * Unmappable-market sweep (issue #745).
 *
 * Reports open markets that no configured adapter can resolve, soonest to
 * expire first. Two jobs:
 *
 *   1. **Catch up.** Markets created before creation-time validation existed
 *      are already in the database, and the ones nobody noticed are the ones
 *      about to expire.
 *   2. **Keep catching.** A provider delists a symbol after creation, and a
 *      market that was mappable at creation stops being mappable. Creation-time
 *      validation cannot see that; a sweep can.
 *
 * Run it from cron, or by hand before a release. Exits non-zero when anything
 * is found, so it can also gate a deployment.
 *
 * Usage:
 *   npm run sweep:unmappable -- --source https://api.example.com
 *   npm run sweep:unmappable -- --source https://api.example.com --params params.json
 *   npm run sweep:unmappable -- --source … --json
 *   npm run sweep:unmappable -- --source … --window-days 90 --no-expired
 *
 * ## The `params` problem
 *
 * Market→adapter params (`symbol`, `comparator`, `threshold`) are not in the
 * `market_created` contract event and `markets` has no column for them, so the
 * candidate endpoint cannot return them. Without `--params`, every market is
 * reported as `unknown-params` — *unclassified*, not fine. The file maps
 * market id → params:
 *
 *   { "1": { "symbol": "BTCUSDT", "comparator": "gte", "threshold": 100000 } }
 */

import { readFileSync } from "node:fs";

import {
  collectUnmappableMarkets,
  MappabilityOverrides,
  MarketMappabilityRegistry,
  type MappabilityOverride,
  type SweepableMarket,
} from "./mappability.js";
import { BinanceAdapter } from "./binance.js";
import { CoinGeckoAdapter } from "./coingecko.js";
import type { DataAdapter } from "./index.js";

const USAGE = `
Unmappable-market sweep.

  --source <url>        API origin to read the candidate set from
                        (default: $SWEEP_SOURCE_URL, then $SMOKE_BASE_URL)
  --params <path>       JSON file of market id → adapter params. Required to
                        classify markets at all: the database does not store
                        these, so without it every market is reported as
                        unclassified rather than fine. (default:
                        $MARKET_PARAMS_FILE)
  --window-days <n>     Only report markets expiring within n days (default: 30)
  --no-expired          Exclude markets already past end_time
  --json                Emit JSON instead of a table
  --adapters <ids>      Comma-separated adapter ids to check against
                        (default: binance,coinmarketcap,coingecko)
  -h, --help            Show this message

Exit codes: 0 = nothing unmappable, 1 = at least one market found,
2 = usage/config error.
`.trim();

interface CliOptions {
  source?: string;
  paramsPath?: string;
  windowDays: number;
  includeExpired: boolean;
  json: boolean;
  adapterIds: string[];
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    windowDays: 30,
    includeExpired: true,
    json: false,
    adapterIds: ["binance", "coinmarketcap", "coingecko"],
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
      case "--source": options.source = next(); break;
      case "--params": options.paramsPath = next(); break;
      case "--window-days": options.windowDays = Number(next()); break;
      case "--no-expired": options.includeExpired = false; break;
      case "--json": options.json = true; break;
      case "--adapters": options.adapterIds = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.windowDays) || options.windowDays <= 0) {
    throw new Error("--window-days must be a positive number");
  }
  if (options.adapterIds.length === 0) {
    throw new Error("--adapters must name at least one adapter");
  }

  return options;
}

/** Adapters are only needed for their `supports()`; no provider is contacted. */
function adaptersFor(ids: readonly string[]): DataAdapter[] {
  const byId: Record<string, DataAdapter> = {
    binance: new BinanceAdapter(),
    coingecko: new CoinGeckoAdapter(),
  };
  return ids.filter((id) => id in byId).map((id) => byId[id]!);
}

interface CandidateResponse {
  /** Candidate rows exactly as the API returns them (`end_time`, not `endTime`). */
  candidates: Array<{
    id: string;
    category: string;
    end_time?: string | number;
    question?: string;
  }>;
  checkedAt: string;
}

async function fetchCandidates(source: string, timeoutMs: number): Promise<CandidateResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${source.replace(/\/+$/, "")}/api/markets/unmappable`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`candidate endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as CandidateResponse;
    if (!Array.isArray(body.candidates)) {
      throw new Error("candidate endpoint returned no `candidates` array");
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Maps the API's row shape onto the sweep's, including `end_time` → `endTime`. */
function toSweepable(
  candidate: CandidateResponse["candidates"][number],
  params: Record<string, unknown> | undefined,
): SweepableMarket {
  return {
    id: String(candidate.id),
    category: candidate.category,
    ...(params === undefined ? {} : { params }),
    ...(candidate.question === undefined ? {} : { question: candidate.question }),
    ...(candidate.end_time === undefined ? {} : { endTime: candidate.end_time }),
  };
}

/** market id → params, merged onto the candidates. */
function loadParams(path: string | undefined): Map<string, Record<string, unknown>> {
  if (path === undefined || path.length === 0) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read market params from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`market params from ${path} must be a JSON object of market id → params`);
  }

  const map = new Map<string, Record<string, unknown>>();
  for (const [id, params] of Object.entries(parsed as Record<string, unknown>)) {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(`market params for "${id}" must be an object`);
    }
    map.set(id, params as Record<string, unknown>);
  }
  return map;
}

function formatTable(
  markets: ReturnType<typeof collectUnmappableMarkets>,
  checked: number,
  hadParams: boolean,
): string {
  const lines: string[] = [];

  if (!hadParams) {
    lines.push(
      "WARNING: no --params supplied. Market→adapter params are not stored in the database,",
    );
    lines.push(
      "         so every market below is UNCLASSIFIED rather than known-unmappable. Treat this",
    );
    lines.push(
      "         run as a list of markets to check by hand, not as a clean bill of health.",
    );
    lines.push("");
  }

  lines.push(`Checked ${checked} open market(s).`);
  lines.push("");

  if (markets.length === 0) {
    lines.push("No unmappable markets. Nothing to do.");
    return lines.join("\n");
  }

  for (const market of markets) {
    const when =
      market.secondsUntilExpiry === undefined
        ? "expiry unknown"
        : market.pastExpiry
          ? `EXPIRED ${formatDuration(-market.secondsUntilExpiry)} ago`
          : `expires in ${formatDuration(market.secondsUntilExpiry)}`;

    lines.push(`  market ${market.id}  [${market.category}]  ${when}`);
    lines.push(`    why:  ${market.detail}`);
    lines.push(`    fix:  ${market.remedy}`);
    if (market.question) lines.push(`    what: ${market.question}`);
    lines.push("");
  }

  lines.push(
    `${markets.length} market(s) cannot be resolved, or could not be classified. ` +
      "Add a mapping via MARKET_MAPPABILITY_OVERRIDES — no redeploy needed.",
  );
  return lines.join("\n");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
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

  const source = options.source ?? process.env.SWEEP_SOURCE_URL ?? process.env.SMOKE_BASE_URL ?? "";
  if (source.length === 0) {
    console.error("No source supplied. Pass --source or set SWEEP_SOURCE_URL.");
    console.error(`\n${USAGE}`);
    process.exit(2);
  }

  const overrides: MappabilityOverride | undefined = new MappabilityOverrides().load();
  if (overrides) {
    const count =
      Object.values(overrides.symbols ?? {}).flat().length +
      (overrides.categories ?? []).length +
      Object.values(overrides.unsupported ?? {}).flat().length;
    console.error(`[sweep] loaded ${count} mappability override(s)`);
  }

  const paramsPath = options.paramsPath ?? process.env.MARKET_PARAMS_FILE;
  const paramsById = loadParams(paramsPath);
  if (paramsById.size > 0) {
    console.error(`[sweep] loaded params for ${paramsById.size} market(s) from ${paramsPath}`);
  }

  const adapters = adaptersFor(options.adapterIds);
  const registry = MarketMappabilityRegistry.fromAdapters(adapters);

  const { candidates } = await fetchCandidates(source, 15_000);
  const withParams: SweepableMarket[] = candidates.map((candidate) =>
    toSweepable(candidate, paramsById.get(String(candidate.id))),
  );

  const unmappable = collectUnmappableMarkets(withParams, {
    adapters,
    registry,
    overrides,
    withinSeconds: options.windowDays * 24 * 3600,
    includeExpired: options.includeExpired,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          checked: candidates.length,
          classified: withParams.filter((m) => m.params !== undefined).length,
          unmappable,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatTable(unmappable, candidates.length, paramsById.size > 0));
  }

  process.exitCode = unmappable.length > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error("sweep crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
