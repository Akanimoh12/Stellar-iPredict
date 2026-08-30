
import { loadSecrets, summariseSecretsLoad } from "@ipredict/shared";
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


import { handleMarketCancelledEvent } from "./handlers/market_cancelled.js";
import { handleBetPlacedEvent, isBetPlacedTopic } from "./handlers/bet_placed.js";
import { handleMarketCreatedEvent } from "./handlers/market_created.js";
import { handleMarketResolvedEvent } from "./handlers/market_resolved.js";
import { handleOracleChallengedEvent, handleOracleEscalatedEvent } from "./handlers/oracle_challenge.js";
import { handleOracleFinalizedEvent } from "./handlers/oracle_finalized.js";
import { handleReferralRewardEvent } from "./handlers/referral_reward.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "./types.js";

export async function writeEventToDb(event: DecodedContractEvent, db: DbClient, redis: RedisClient): Promise<void> {
  const [domain, action] = event.topics;

  if (domain === "mkt" && action === "created") {
    await handleMarketCreatedEvent(event, db, redis);
  } else if (isBetPlacedTopic(event.topics)) {
    await handleBetPlacedEvent(event, db, redis);
  } else if (domain === "market_resolved" || (domain === "mkt" && action === "resolved")) {
    await handleMarketResolvedEvent(event, db, redis);
  } else if (domain === "mkt" && action === "cancelled") {
    await handleMarketCancelledEvent(event, db, redis);
  } else if (domain === "referral" && action === "reward") {
    await handleReferralRewardEvent(event, db, redis);
  } else if (domain === "oracle" && action === "challenged") {
    await handleOracleChallengedEvent(event, db, redis);
  } else if (domain === "oracle" && action === "escalated") {
    await handleOracleEscalatedEvent(event, db, redis);
  } else if (domain === "oracle" && action === "finalized") {
    await handleOracleFinalizedEvent(event, db, redis);
  }
}

/**
 * Main entry point for the indexer service.
 * Starts the metrics server and runs the indexer polling loop.
 */
export async function main(): Promise<void> {
  // Resolve the secrets source before anything reads process.env. See
  // docs/SECRETS.md; the summary is counts only, never names or values.
  const secrets = await loadSecrets();
  console.info(`[ipredict-indexer] secrets: ${summariseSecretsLoad(secrets)}`);

  // Initialize metrics server
  const metricsServer = new MetricsServer();

  // TODO: Create indexer runtime and start indexing
  // This will be implemented once the full runtime setup is in place

  const indexer = new Indexer({} as IndexerRuntime, metricsServer);
  installGracefulShutdown(indexer);

  await indexer.start();
}
