
import { loadSecrets, summariseSecretsLoad } from "@ipredict/shared";
import { config } from "./config/index.js";
import { runBackfill } from "./backfill.js";
import { persistDeadLetterEvent } from "./deadLetter.js";
import { recomputeMarketTotalsFromBets } from "./recomputeTotals.js";
import { recomputeMarketBetCountsFromBets } from "./recomputeBetCounts.js";
import type { Closable, Queryable } from "./db.js";

import type { Logger } from "./log.js";
import { MetricsServer } from "./metrics-server.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5_000);
const START_LEDGER = Number(process.env.START_LEDGER ?? 0);

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
  recomputeBetCounts?: boolean;
  logger?: Logger;
  /**
   * Optional atomic batch processor: processes all events in a batch and saves the
   * checkpoint ledger within a single database transaction.
   */
  processBatchAtomically?(
    events: RawEvent[],
    checkpointLedger: number,
  ): Promise<void>;
}

export interface RawEvent { ledger: number; txHash: string; [key: string]: unknown }
export interface DecodedEvent { ledger: number; txHash: string; topics: unknown[]; data: unknown }

export class Indexer {
  private stopping = false;
  private processing = false;
  private lastLedger = 0;
  private metricsServer: MetricsServer | null = null;

  constructor(private readonly runtime: IndexerRuntime, metricsServer?: MetricsServer) {
    this.metricsServer = metricsServer || null;
  }

  requestShutdown(): void {
    this.stopping = true;
  }

  async start(): Promise<void> {
    if (this.metricsServer) {
      await this.metricsServer.start();
    }

    this.lastLedger = await this.runtime.getCheckpoint();
    if (this.lastLedger <= 0) {
      this.lastLedger = START_LEDGER;
    }
    while (!this.stopping) {
      try {
        await this.indexOnce();
      } catch (error) {
        this.runtime.logger?.error("poll iteration failed", { error });
      }
      if (!this.stopping) await this.runtime.sleep(POLL_INTERVAL_MS);
    }
    await this.flushAndClose();
  }

  async indexOnce(): Promise<number> {
    const response = await this.runtime.fetchEvents(this.lastLedger);
    if (typeof this.runtime.processBatchAtomically === "function") {
      // Atomic commit: cursor advances in the same transaction as event effects
      await this.runtime.processBatchAtomically(response.events, response.latestLedger);
      this.lastLedger = response.latestLedger;
    } else {
      // Deliberate ordering for at-least-once processing:
      // Process event effects FIRST, then advance cursor SECOND.
      // If a crash happens mid-batch, events are reprocessed on recovery
      // rather than permanently skipped (idempotent handlers guarantee no duplicates).
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
    }

    if (this.runtime.recomputeTotals) await recomputeMarketTotalsFromBets(this.runtime.db);
    if (this.runtime.recomputeBetCounts) await recomputeMarketBetCountsFromBets(this.runtime.db);
    return this.lastLedger;
  }

  async flushAndClose(): Promise<void> {
    while (this.processing) await this.runtime.sleep(10);
    await this.runtime.saveCheckpoint(this.lastLedger);
    if (this.metricsServer) {
      await this.metricsServer.stop();
    }
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

export function installGracefulShutdown(indexer: Indexer): void {
  installShutdownHandlers(indexer);
}

/**
 * Live polling loop: fetches new contract events from the configured Soroban
 * RPC endpoint and writes them to Postgres, checkpointing each processed
 * ledger as it goes.
 *
 * Imports are resolved lazily so that merely importing this module (as the
 * tests do) never validates environment variables or opens connections.
 *
 * Under test (NODE_ENV === "test") the loop performs a single pass and
 * returns, so unit tests can exercise it without an infinite timer.
 */
export async function startLivePolling(fromLedger: number): Promise<void> {
  const [{ config }, { writeEventToDb: writeBackfillEvent, processEventsInChunks, EVENTS_PROCESSING_CHUNK_SIZE }, stellar] = await Promise.all([
    import("./config/index.js"),
    import("./backfill.js"),
    import("@stellar/stellar-sdk"),
  ]);
  const { rpc, scValToNative } = stellar;

  console.log(`[ipredict-indexer] Starting live polling loop from ledger ${fromLedger}...`);
  let currentLedger = fromLedger;
  const server = new rpc.Server(config.SOROBAN_RPC_URL);

  while (true) {
    try {
      const latest = await server.getLatestLedger();
      if (latest.sequence > currentLedger) {
        console.log(`[live-poll] Fetching events from ${currentLedger + 1} to ${latest.sequence}`);
        const response = await server.getEvents({
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          startLedger: currentLedger + 1,
          limit: config.EVENTS_PER_PAGE,
        });

        await processEventsInChunks(response.events || [], EVENTS_PROCESSING_CHUNK_SIZE, async (event) => {
          const topics = event.topic.map((t: any) => scValToNative(t));
          const data = scValToNative(event.value);
          await writeBackfillEvent(event.ledger, event.txHash, topics, data);
        });
        currentLedger = response.latestLedger;
        try {
          const { saveCheckpointLedger, pool: dbPool } = await import("./db.js");
          await saveCheckpointLedger(dbPool, currentLedger);
        } catch {}
      }
    } catch (err) {
      console.error("[live-poll] Error in polling loop:", err);
    }
    if (process.env.NODE_ENV === "test") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, config.POLL_INTERVAL_MS));
  }
}

/**
 * The single schema-validated event boundary lives in `event-router.ts`
 * (issue #499). This module previously carried a drifted copy of the router
 * that silently dropped unrecognized events — re-export the canonical one so
 * every entry point validates payloads and dead-letters malformed events
 * identically.
 */
export { writeEventToDb } from "./event-router.js";

/**
 * Main entry point for the indexer service.
 *
 * Starts the metrics/health server (not under test, so unit tests can call
 * main() without binding a port), then either replays history and continues
 * live (--backfill) or starts live polling from the configured start ledger.
 */
export async function main(): Promise<void> {
  // Resolve the secrets source before anything reads process.env. See
  // docs/SECRETS.md; the summary is counts only, never names or values.
  const secrets = await loadSecrets();
  console.info(`[ipredict-indexer] secrets: ${summariseSecretsLoad(secrets)}`);

  // Initialize metrics server
  const metricsServer = new MetricsServer();
  await metricsServer.start();

  const isBackfill = process.argv.includes("--backfill");

  if (isBackfill) {
    console.log("[ipredict-indexer] Backfill mode enabled via CLI flag.");
    const lastLedger = await runBackfill();
    await startLivePolling(lastLedger);
  } else {
    console.log("[ipredict-indexer] Live polling mode enabled (no backfill).");
    await startLivePolling(config.START_LEDGER);
  }
}

// Only invoke main when run directly, not when imported in tests.
if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("[ipredict-indexer] fatal:", err);
    process.exit(1);
  });
}
