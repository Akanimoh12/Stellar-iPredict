/**
 * Standalone leaderboard rebuild job — entry point for npm run rebuild:leaderboard
 *
 * This script rebuilds the leaderboard snapshot from scratch by replaying all
 * events from the events table. It is safe to run at any time without affecting
 * the live indexer, and is fully idempotent.
 *
 * Usage:
 *   npm run rebuild:leaderboard [--dry-run] [--since-ledger N]
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (required)
 *   LOG_LEVEL — debug|info|warn|error (optional, default: info)
 */

import { Pool } from "pg";
import { rebuildLeaderboardTable } from "./leaderboard-rebuild.js";
import { createLogger, logIterationSummary, parseLogLevel } from "./log.js";

function parseSinceLedger(argv: string[]): number | undefined {
  const exact = argv.find((arg) => arg.startsWith("--since-ledger="));
  if (exact) {
    const value = Number(exact.split("=", 2)[1]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  const index = argv.indexOf("--since-ledger");
  if (index >= 0 && argv[index + 1]) {
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  return undefined;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to rebuild the leaderboard");
  }

  const dryRun = process.argv.includes("--dry-run");
  const sinceLedger = parseSinceLedger(process.argv.slice(2));
  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "leaderboard-rebuild" },
  });

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query("BEGIN");
    logger.info("leaderboard rebuild started", {
      dryRun,
      sinceLedger: sinceLedger ?? null,
      logLevel: logger.level,
    });

    const snapshot = await rebuildLeaderboardTable(client, {
      dryRun,
      sinceLedger,
    });

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    logIterationSummary(logger, {
      eventsProcessed: snapshot.eventCount,
      lagLedgers:
        sinceLedger !== undefined && snapshot.lastLedgerSeq !== null
          ? Math.max(snapshot.lastLedgerSeq - sinceLedger, 0)
          : 0,
      durationMs: Date.now() - startedAt,
      lastLedgerSeq: snapshot.lastLedgerSeq,
      checkpointLedger: sinceLedger,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error("leaderboard rebuild failed", {
      dryRun,
      sinceLedger: sinceLedger ?? null,
      error,
    });
    process.exitCode = 1;
    return;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "leaderboard-rebuild" },
  });
  logger.error("leaderboard rebuild fatal", { error });
  process.exitCode = 1;
});
