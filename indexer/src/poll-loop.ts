import type { Logger } from "./log.js";
import { metrics } from "./metrics.js";
import { recordPollLoopProgress } from "./health.js";

export interface RpcEvent {
  contractId: string;
  ledger: number;
  type: string;
  body: unknown;
}

export interface RpcClient {
  getEvents(opts: {
    startLedger: number;
    contractIds: string[];
    limit?: number;
  }): Promise<{ events: RpcEvent[]; latestLedger: number }>;
}

export interface PollDb {
  getCheckpointLedger(): Promise<number | null>;
  saveCheckpointLedger(ledger: number): Promise<void>;
  insertEvents(events: RpcEvent[]): Promise<void>;
  /**
   * Optional atomic persistence of events and checkpoint ledger in a single transaction.
   * If provided, pollOnce will use this to ensure cursor position and event effects
   * commit atomically.
   */
  processEventsWithCheckpoint?(events: RpcEvent[], checkpointLedger: number): Promise<void>;
}

export interface PollOnceConfig {
  rpc: RpcClient;
  db: PollDb;
  contractIds: string[];
  defaultStartLedger?: number;
  logger?: Logger;
}

export interface PollOnceResult {
  eventsWritten: number;
  latestLedger: number;
}

export async function pollOnce(config: PollOnceConfig): Promise<PollOnceResult> {
  const { rpc, db, contractIds, defaultStartLedger = 0, logger } = config;
  const startTime = Date.now();

  const checkpoint = await db.getCheckpointLedger();
  const startLedger = checkpoint !== null ? checkpoint + 1 : defaultStartLedger;

  logger?.debug("polling events", { startLedger, contractCount: contractIds.length });

  const { events, latestLedger } = await rpc.getEvents({ startLedger, contractIds });

  if (typeof db.processEventsWithCheckpoint === "function") {
    // Atomic commit: cursor advances in the same transaction as the event effects
    await db.processEventsWithCheckpoint(events, latestLedger);
  } else {
    // Deliberate ordering for at-least-once processing:
    // Process event effects FIRST, then advance cursor SECOND.
    // If a crash happens between the two, events are reprocessed on recovery
    // rather than permanently skipped (idempotent handlers guarantee no duplicates).
    if (events.length > 0) {
      await db.insertEvents(events);
    }

    await db.saveCheckpointLedger(latestLedger);
  }

  // Compute and update indexer lag metric
  const lag = latestLedger - (checkpoint ?? defaultStartLedger);
  metrics.indexerLag.set(lag);

  // Record poll duration
  const durationSeconds = (Date.now() - startTime) / 1000;
  metrics.pollDuration.observe(durationSeconds);

  // Update health tracking
  recordPollLoopProgress(latestLedger);

  logger?.info("poll iteration complete", { eventsWritten: events.length, latestLedger, lag, durationSeconds });

  return { eventsWritten: events.length, latestLedger };
}

export interface PollLoopConfig extends PollOnceConfig {
  pollIntervalMs?: number;
}

export async function runPollLoop(
  config: PollLoopConfig,
  signal: AbortSignal
): Promise<void> {
  const { pollIntervalMs = 5000 } = config;

  while (!signal.aborted) {
    try {
      await pollOnce(config);
    } catch (error) {
      config.logger?.error("poll iteration failed", { error });
    }

    if (signal.aborted) break;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
