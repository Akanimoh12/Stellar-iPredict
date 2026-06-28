
import { persistDeadLetterEvent } from "./deadLetter.js";
import { recomputeMarketTotalsFromBets } from "./recomputeTotals.js";
import type { Closable, Queryable } from "./db.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5_000);

export interface RedisLike extends Closable {
  del(key: string): Promise<unknown>;
}

export interface IndexerRuntime {
  db: Queryable & Closable;
  redis?: RedisLike;
  getCheckpoint(): Promise<number>;
  saveCheckpoint(ledger: number): Promise<void>;
  fetchEvents(fromLedger: number): Promise<{ latestLedger: number; events: RawEvent[] }>;
  decodeEvent(event: RawEvent): DecodedEvent;
  writeEventToDb(event: DecodedEvent): Promise<void>;
  sleep(ms: number): Promise<void>;
  recomputeTotals?: boolean;
}

export interface RawEvent { ledger: number; txHash: string; [key: string]: unknown }
export interface DecodedEvent { ledger: number; txHash: string; topics: unknown[]; data: unknown }

export class Indexer {
  private stopping = false;
  private processing = false;
  private lastLedger = 0;

  constructor(private readonly runtime: IndexerRuntime) {}

  requestShutdown(): void {
    this.stopping = true;
  }

  async start(): Promise<void> {
    this.lastLedger = await this.runtime.getCheckpoint();
    while (!this.stopping) {
      await this.indexOnce();
      if (!this.stopping) await this.runtime.sleep(POLL_INTERVAL_MS);
    }
    await this.flushAndClose();
  }

  async indexOnce(): Promise<number> {
    const response = await this.runtime.fetchEvents(this.lastLedger);
    for (const event of response.events) {
      if (this.stopping) break;
      this.processing = true;
      try {
        const decoded = this.runtime.decodeEvent(event);
        await this.runtime.writeEventToDb(decoded);
      } catch (error) {
        await persistDeadLetterEvent(this.runtime.db, {
          ledger: event.ledger,
          txHash: event.txHash,
          rawEvent: event,
          error,
        });
      } finally {
        this.processing = false;
      }
    }
    this.lastLedger = response.latestLedger;
    await this.runtime.saveCheckpoint(this.lastLedger);
    if (this.runtime.recomputeTotals) await recomputeMarketTotalsFromBets(this.runtime.db);
    return this.lastLedger;
  }

  async flushAndClose(): Promise<void> {
    while (this.processing) await this.runtime.sleep(10);
    await this.runtime.saveCheckpoint(this.lastLedger);
    await this.runtime.redis?.end();
    await this.runtime.db.end();
  }
}

export function installShutdownHandlers(indexer: Indexer): void {
  let shutdownStarted = false;
  const handler = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    indexer.requestShutdown();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}


import { handleMarketCancelledEvent } from "./handlers/market_cancelled.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "./types.js";

export async function writeEventToDb(event: DecodedContractEvent, db: DbClient, redis: RedisClient): Promise<void> {
  const [domain, action] = event.topics;

  if (domain === "mkt" && action === "cancelled") {
    await handleMarketCancelledEvent(event, db, redis);
  }
}

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
    logger.info("indexer run started", {
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
    logger.error("indexer run failed", {
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
  logger.error("indexer fatal", { error });
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


