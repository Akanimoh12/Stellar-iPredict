import type { Logger } from "./log.js";

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

  const checkpoint = await db.getCheckpointLedger();
  const startLedger = checkpoint !== null ? checkpoint + 1 : defaultStartLedger;

  logger?.debug("polling events", { startLedger, contractCount: contractIds.length });

  const { events, latestLedger } = await rpc.getEvents({ startLedger, contractIds });

  if (events.length > 0) {
    await db.insertEvents(events);
  }

  await db.saveCheckpointLedger(latestLedger);

  logger?.info("poll iteration complete", { eventsWritten: events.length, latestLedger });

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
