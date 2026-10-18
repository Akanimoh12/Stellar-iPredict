import type { Logger } from "./log.js";
import { metrics, recordIndexerCursorAdvance, recordIndexerPosition } from "./metrics.js";
import { recordPollLoopProgress } from "./health.js";
import { LedgerGapError } from "./rpc/getEvents.js";

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
  /**
   * Replays a detected gap or ledger regression and durably checkpoints the
   * recovered range. Return the resulting checkpoint ledger.
   */
  recoverLedgerGap?: (error: LedgerGapError) => Promise<number>;
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

  let response: { events: RpcEvent[]; latestLedger: number };
  try {
    response = await rpc.getEvents({ startLedger, contractIds });
  } catch (error) {
    if (!(error instanceof LedgerGapError)) throw error;
    return recoverLedgerGap(config, error, startLedger, checkpoint);
  }

  const earlyLedger = response.events.reduce<number | null>(
    (earliest, event) => event.ledger < startLedger && (earliest === null || event.ledger < earliest)
      ? event.ledger
      : earliest,
    null,
  );
  if (earlyLedger !== null) {
    return recoverLedgerGap(
      config,
      new LedgerGapError(
        startLedger,
        `RPC returned event ledger ${earlyLedger} before requested ledger ${startLedger}`,
        earlyLedger,
        { fromLedger: earlyLedger, toLedger: startLedger - 1 },
      ),
      startLedger,
      checkpoint,
    );
  }

  const lastKnownLedger = checkpoint ?? startLedger - 1;
  if (response.latestLedger < lastKnownLedger) {
    return recoverLedgerGap(
      config,
      new LedgerGapError(
        startLedger,
        `RPC latest ledger ${response.latestLedger} is behind known ledger ${lastKnownLedger}; possible chain reorganization`,
        response.latestLedger,
        { fromLedger: response.latestLedger + 1, toLedger: lastKnownLedger },
      ),
      startLedger,
      checkpoint,
    );
  }

  const { events, latestLedger } = response;

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

  // Measure the backlog represented by this poll before its checkpoint is
  // advanced. The next poll refreshes the chain-tip observation, so the
  // gauge remains useful even when this batch catches up completely.
  const cursorBeforePoll = checkpoint ?? defaultStartLedger;
  const lag = recordIndexerPosition(latestLedger, cursorBeforePoll);
  recordIndexerCursorAdvance(latestLedger);

  // Record poll duration
  const durationSeconds = (Date.now() - startTime) / 1000;
  metrics.pollDuration.observe(durationSeconds);

  // Update health tracking
  recordPollLoopProgress(latestLedger);

  logger?.info("poll iteration complete", { eventsWritten: events.length, latestLedger, lag, durationSeconds });

  return { eventsWritten: events.length, latestLedger };
}

async function recoverLedgerGap(
  config: PollOnceConfig,
  error: LedgerGapError,
  requestedStartLedger: number,
  checkpoint: number | null,
): Promise<PollOnceResult> {
  config.logger?.error("ledger gap or reorganization detected; backfill required", {
    requestedStartLedger,
    checkpoint,
    oldestLedger: error.oldestLedger,
    unavailableRange: error.unavailableRange,
    error: error.message,
  });

  if (!config.recoverLedgerGap) throw error;

  const recoveredLedger = await config.recoverLedgerGap(error);
  const persistedCheckpoint = await config.db.getCheckpointLedger();
  if (persistedCheckpoint !== recoveredLedger) {
    throw new Error(
      `ledger-gap recovery returned checkpoint ${recoveredLedger}, ` +
      `but database checkpoint is ${persistedCheckpoint}`,
    );
  }

  return { eventsWritten: 0, latestLedger: recoveredLedger };
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
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, pollIntervalMs);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
