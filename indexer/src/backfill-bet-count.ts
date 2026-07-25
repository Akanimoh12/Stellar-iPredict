import { Pool } from "pg";
import { recomputeMarketBetCountsFromBets } from "./recomputeBetCounts.js";
import { createLogger, parseLogLevel } from "./log.js";

/**
 * Standalone maintenance job that recomputes `markets.bet_count` from the
 * `bets` table. See the "bet_count Backfill Job" runbook in
 * docs/ORACLE_AND_BACKEND.md.
 *
 * Pass --dry-run to report drift without writing (the recompute runs inside a
 * transaction that is rolled back).
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to backfill bet_count");
  }

  const dryRun = process.argv.includes("--dry-run");
  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "bet-count-backfill" },
  });

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query("BEGIN");
    logger.info("bet_count backfill started", { dryRun, logLevel: logger.level });

    const result = await recomputeMarketBetCountsFromBets(client);

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    logger.info("bet_count backfill finished", {
      dryRun,
      marketsChecked: result.checked,
      marketsCorrected: result.corrected,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error("bet_count backfill failed", { dryRun, error });
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "bet-count-backfill" },
  });
  logger.error("bet_count backfill fatal", { error });
  process.exitCode = 1;
});
