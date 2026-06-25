import { Pool } from "pg";
import { rebuildLeaderboardTable } from "./leaderboard-rebuild.js";

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
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const snapshot = await rebuildLeaderboardTable(client, {
      dryRun,
      sinceLedger,
    });

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    const summary = [
      `processed ${snapshot.eventCount} event(s)`,
      `rebuilt ${snapshot.players.length} leaderboard row(s)`,
      snapshot.lastLedgerSeq === null ? null : `last ledger ${snapshot.lastLedgerSeq}`,
      sinceLedger === undefined ? null : `checkpoint hint ${sinceLedger}`,
      dryRun ? "dry-run" : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");

    console.log(`[leaderboard-rebuild] ${summary}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[leaderboard-rebuild] ${message}`);
  process.exitCode = 1;
/**
 * iPredict Soroban Event Indexer — entrypoint.
 *
 * Minimal scaffold. The real polling loop, getEvents client, event decoders,
 * checkpoint store, and DB writers are tracked as separate issues
 * (see GitHub issues labelled `area:indexer`).
 *
 * Run: `npm run dev`
 */

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

async function main(): Promise<void> {
  // TODO(#scaffold): replace with the real polling loop once the
  // "Implement getEvents polling loop" issue is done.
  console.log(`[ipredict-indexer] scaffold up — polling loop not yet implemented`);
  console.log(`[ipredict-indexer] intended interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[ipredict-indexer] pick an issue labelled "area:indexer" to start`);
}

main().catch((err) => {
  console.error("[ipredict-indexer] fatal:", err);
  process.exit(1);
});
