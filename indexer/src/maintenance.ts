import type { Queryable } from "./db.js";
import { recomputeMarketBetCountsFromBets } from "./recomputeBetCounts.js";
import { recomputeMarketTotalsFromBets } from "./recomputeTotals.js";
import type { TotalsRecomputeOptions } from "./recomputeTotals.js";
import { createLogger, parseLogLevel } from "./log.js";

export type MaintenanceCommand = "bet-counts" | "totals" | "backfill";

export interface MaintenanceArgs {
  command: MaintenanceCommand;
  dryRun: boolean;
  verifyOnChain: boolean;
  failOnDrift: boolean;
}

export const MAINTENANCE_HELP = `Usage: npm run maintenance -- <command> [options]

Commands:
  backfill      Replay retained Soroban contract events from START_LEDGER
  bet-counts    Recompute markets.bet_count using the bets table
  totals        Recompute markets.total_yes/total_no using the bets table

Options:
  --dry-run          Roll back reconciliation writes (bet-counts/totals only)
  --verify-onchain   Compare totals with Soroban get_market views (totals only)
  --fail-on-drift    Exit unsuccessfully if any verified market has drift
  --help             Show this help

Examples:
  npm run maintenance -- bet-counts --dry-run
  npm run maintenance -- totals --verify-onchain --fail-on-drift
  npm run maintenance -- backfill
`;

export function parseMaintenanceArgs(args: string[]): MaintenanceArgs {
  const [command, ...flags] = args;
  if (command !== "backfill" && command !== "bet-counts" && command !== "totals") {
    throw new Error(`Unknown maintenance command: ${command ?? "(missing)"}`);
  }
  for (const flag of flags) {
    if (!["--dry-run", "--verify-onchain", "--fail-on-drift"].includes(flag)) {
      throw new Error(`Unknown maintenance option: ${flag}`);
    }
  }
  const dryRun = flags.includes("--dry-run");
  const verifyOnChain = flags.includes("--verify-onchain");
  const failOnDrift = flags.includes("--fail-on-drift");
  if (command === "backfill" && (dryRun || verifyOnChain || failOnDrift)) {
    throw new Error("Backfill does not support reconciliation flags");
  }
  if (command !== "totals" && (verifyOnChain || failOnDrift)) {
    throw new Error("On-chain verification is only supported for totals");
  }
  if (failOnDrift && !verifyOnChain) {
    throw new Error("--fail-on-drift requires --verify-onchain");
  }
  return { command, dryRun, verifyOnChain, failOnDrift };
}

export interface MaintenanceResult {
  checked: number;
  corrected: number;
  onChainChecked?: number;
  driftCount?: number;
}

/** The transaction is owned by the CLI, never by the underlying pure functions. */
export async function executeReconciliation(
  db: Queryable,
  args: MaintenanceArgs,
  options: TotalsRecomputeOptions = {},
): Promise<MaintenanceResult> {
  if (args.command === "backfill") throw new Error("Backfill uses the RPC replay runner");
  await db.query("BEGIN");
  try {
    const result = args.command === "bet-counts"
      ? await recomputeMarketBetCountsFromBets(db)
      : await recomputeMarketTotalsFromBets(db, options);
    await db.query(args.dryRun ? "ROLLBACK" : "COMMIT");
    const totals = args.command === "totals" ? result as Awaited<ReturnType<typeof recomputeMarketTotalsFromBets>> : null;
    return {
      checked: result.checked,
      corrected: result.corrected,
      ...(totals?.onChainChecked !== undefined ? { onChainChecked: totals.onChainChecked } : {}),
      ...(totals?.drift !== undefined ? { driftCount: totals.drift.length } : {}),
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Single entry point for all historical and aggregate indexer maintenance. */
export async function runMaintenanceCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
    console.log(MAINTENANCE_HELP);
    return;
  }
  const args = parseMaintenanceArgs(argv);
  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "maintenance", command: args.command },
  });
  const startedAt = Date.now();

  if (args.command === "backfill") {
    const { runBackfill } = await import("./backfill.js");
    const { pool } = await import("./db.js");
    try {
      logger.info("backfill started");
      const latestLedger = await runBackfill();
      logger.info("backfill completed", { latestLedger, durationMs: Date.now() - startedAt });
    } finally {
      await pool.end();
    }
    return;
  }

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  // Lazy imports keep the parser and unit tests independent of connection setup.
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const options: TotalsRecomputeOptions = {};
    if (args.verifyOnChain) {
      const { createOnChainTotalsReader } = await import("./chain-totals.js");
      const { SOROBAN_RPC_URL, NETWORK_PASSPHRASE, MARKET_CONTRACT_ID } = process.env;
      if (!SOROBAN_RPC_URL || !NETWORK_PASSPHRASE || !MARKET_CONTRACT_ID) {
        throw new Error("On-chain verification requires SOROBAN_RPC_URL, NETWORK_PASSPHRASE and MARKET_CONTRACT_ID");
      }
      options.getOnChainTotals = createOnChainTotalsReader({
        rpcUrl: SOROBAN_RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        marketContractId: MARKET_CONTRACT_ID,
        simulationSource: process.env.SIMULATION_SOURCE_ACCOUNT,
      });
      options.onDrift = (drift) => logger.warn("market totals drift detected", {
        marketId: drift.marketId, database: drift.database, onChain: drift.onChain,
      });
    }
    logger.info("reconciliation started", { dryRun: args.dryRun, verifyOnChain: args.verifyOnChain });
    const result = await executeReconciliation(client, args, options);
    logger.info("reconciliation finished", {
      ...result,
      dryRun: args.dryRun,
      durationMs: Date.now() - startedAt,
    });
    if (args.failOnDrift && (result.driftCount ?? 0) > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error("maintenance failed", { error });
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
