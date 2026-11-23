import type { Logger } from "./log.js";
import {
  metrics,
  recordBackpressureState,
  recordIndexerCursorAdvance,
  recordIndexerPosition,
} from "./metrics.js";
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
  /** Page size handed to `getEvents`. Omitted when not configured. */
  eventsPerPage?: number;
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
    const request: { startLedger: number; contractIds: string[]; limit?: number } = {
      startLedger,
      contractIds,
    };
    // Only send a limit when one was chosen: existing RPC mocks and callers
    // that own their page size must keep working unchanged.
    if (config.eventsPerPage !== undefined) request.limit = config.eventsPerPage;
    response = await rpc.getEvents(request);
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

  // Issue #928: Atomic checkpoint advance with event processing
  // Use processEventsWithCheckpoint() when available to ensure cursor
  // and handler writes share a transaction so a crash cannot skip or
  // double-apply events. Falls back to at-least-once (effects first,
  // then cursor) when atomic commit is not available.
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

// ---------------------------------------------------------------------------
// Adaptive backpressure — issue #636
// ---------------------------------------------------------------------------

export interface BackpressureControllerOptions {
  /** Baseline poll interval the controller returns to when healthy. */
  basePollIntervalMs: number;
  /** Baseline page size the controller returns to when healthy. */
  maxEventsPerPage: number;
  minPollIntervalMs?: number;
  maxPollIntervalMs?: number;
  minEventsPerPage?: number;
  /** An iteration taking this fraction of the interval is "slow". Default 0.8. */
  pressureRatio?: number;
  /** An iteration below this fraction is a recovery sample. Default 0.4. */
  recoveryRatio?: number;
  /** Slow iterations before sustained backpressure alerts. Default 3. */
  sustainedSamples?: number;
  /** Fast iterations before widening the page again. Default 5. */
  recoverySamples?: number;
  /** Multiplier applied to the interval (and inverse to the page). Default 1.5. */
  adaptationFactor?: number;
  /** Injected clock for deterministic callers. */
  now?: () => number;
}

export interface BackpressureObservation {
  durationMs: number;
  eventsWritten?: number;
  /** Current chain-tip minus checkpoint, when the caller knows it. */
  lagLedgers?: number;
  /** A failed iteration is always a backpressure sample. */
  failed?: boolean;
}

export interface BackpressureDecision {
  pollIntervalMs: number;
  eventsPerPage: number;
  /** True for this individual slow iteration. */
  pressured: boolean;
  /** True while the slow trend has lasted `sustainedSamples` iterations. */
  sustained: boolean;
  /** True once per sustained episode — fire the alert on this edge. */
  shouldAlert: boolean;
  /** 0 while healthy, 1 once sustained — suitable for a gauge. */
  level: number;
  observedAtMs: number;
  consecutivePressureSamples: number;
  consecutiveRecoverySamples: number;
}

/**
 * A proportional controller for the poll loop (issue #636).
 *
 * It never changes *which* ledgers are processed — `pollOnce` always resumes
 * from the durable checkpoint + 1. It only lengthens the wait between polls
 * and shrinks the event page while the database is slow, then walks both back
 * to their configured baselines after several fast iterations. Slowing intake
 * is deliberate: adding more work to a saturated database grows the backlog
 * faster, not slower.
 */
export class AdaptivePollController {
  private readonly basePollIntervalMs: number;
  private readonly baseEventsPerPage: number;
  private readonly minPollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly minEventsPerPage: number;
  private readonly maxEventsPerPage: number;
  private readonly pressureRatio: number;
  private readonly recoveryRatio: number;
  private readonly sustainedSamples: number;
  private readonly recoverySamples: number;
  private readonly adaptationFactor: number;
  private readonly now: () => number;

  private intervalMs: number;
  private eventsPerPage: number;
  private pressureCount = 0;
  private recoveryCount = 0;
  private previousLag: number | null = null;
  private alerted = false;
  private lastDecision: BackpressureDecision;

  constructor(options: BackpressureControllerOptions) {
    this.basePollIntervalMs = Math.max(1, Math.floor(options.basePollIntervalMs));
    this.baseEventsPerPage = Math.max(1, Math.floor(options.maxEventsPerPage));
    this.minPollIntervalMs = Math.max(
      1,
      Math.min(this.basePollIntervalMs, Math.floor(options.minPollIntervalMs ?? 1_000)),
    );
    this.maxPollIntervalMs = Math.max(
      this.basePollIntervalMs,
      Math.floor(options.maxPollIntervalMs ?? 60_000),
    );
    this.minEventsPerPage = Math.max(
      1,
      Math.min(this.baseEventsPerPage, Math.floor(options.minEventsPerPage ?? 25)),
    );
    this.maxEventsPerPage = this.baseEventsPerPage;
    this.pressureRatio = options.pressureRatio ?? 0.8;
    this.recoveryRatio = options.recoveryRatio ?? 0.4;
    this.sustainedSamples = Math.max(1, Math.floor(options.sustainedSamples ?? 3));
    this.recoverySamples = Math.max(1, Math.floor(options.recoverySamples ?? 5));
    this.adaptationFactor = Math.max(1.01, options.adaptationFactor ?? 1.5);
    this.now = options.now ?? Date.now;

    this.intervalMs = this.basePollIntervalMs;
    this.eventsPerPage = this.baseEventsPerPage;
    this.lastDecision = this.buildDecision(false, false, false);
  }

  /** Current decision without taking another sample. */
  current(): BackpressureDecision {
    return { ...this.lastDecision };
  }

  /**
   * Folds one completed iteration into the controller and returns the settings
   * to use for the next one.
   */
  observe(observation: BackpressureObservation): BackpressureDecision {
    const lag = observation.lagLedgers;
    const backlogGrowing =
      lag !== undefined &&
      this.previousLag !== null &&
      lag > this.previousLag &&
      (observation.eventsWritten ?? 0) > 0;
    if (lag !== undefined) this.previousLag = lag;

    const slow =
      observation.failed === true ||
      observation.durationMs >= this.intervalMs * this.pressureRatio ||
      backlogGrowing;
    const fast =
      observation.failed !== true &&
      observation.durationMs <= this.intervalMs * this.recoveryRatio;

    if (slow) {
      this.pressureCount += 1;
      this.recoveryCount = 0;
      this.intervalMs = Math.min(
        this.maxPollIntervalMs,
        Math.ceil(this.intervalMs * this.adaptationFactor),
      );
      this.eventsPerPage = Math.max(
        this.minEventsPerPage,
        Math.floor(this.eventsPerPage / this.adaptationFactor),
      );
    } else if (fast) {
      this.recoveryCount += 1;
      this.pressureCount = 0;
      if (this.recoveryCount >= this.recoverySamples) {
        this.recoveryCount = 0;
        this.intervalMs = Math.max(
          this.basePollIntervalMs,
          Math.floor(this.intervalMs / this.adaptationFactor),
        );
        this.eventsPerPage = Math.min(
          this.maxEventsPerPage,
          Math.ceil(this.eventsPerPage * this.adaptationFactor),
        );
      }
    } else {
      // Between the two bands: hold the current rate steady.
      this.pressureCount = 0;
      this.recoveryCount = 0;
    }

    const sustained = slow && this.pressureCount >= this.sustainedSamples;
    const shouldAlert = sustained && !this.alerted;
    if (shouldAlert) this.alerted = true;
    if (!slow) this.alerted = false;

    this.lastDecision = this.buildDecision(slow, sustained, shouldAlert);
    return this.current();
  }

  /** Forget the trend and return to the baseline rates. */
  reset(): void {
    this.intervalMs = this.basePollIntervalMs;
    this.eventsPerPage = this.baseEventsPerPage;
    this.pressureCount = 0;
    this.recoveryCount = 0;
    this.previousLag = null;
    this.alerted = false;
    this.lastDecision = this.buildDecision(false, false, false);
  }

  private buildDecision(
    pressured: boolean,
    sustained: boolean,
    shouldAlert: boolean,
  ): BackpressureDecision {
    return {
      pollIntervalMs: this.intervalMs,
      eventsPerPage: this.eventsPerPage,
      pressured,
      sustained,
      shouldAlert,
      level: sustained ? 1 : pressured ? Math.min(1, this.pressureCount / this.sustainedSamples) : 0,
      observedAtMs: this.now(),
      consecutivePressureSamples: this.pressureCount,
      consecutiveRecoverySamples: this.recoveryCount,
    };
  }
}

export interface PollLoopConfig extends PollOnceConfig {
  pollIntervalMs?: number;
  /** Optional overrides for {@link AdaptivePollController}. */
  backpressure?: Omit<BackpressureControllerOptions, "basePollIntervalMs" | "maxEventsPerPage">;
}

export async function runPollLoop(
  config: PollLoopConfig,
  signal: AbortSignal
): Promise<void> {
  const { pollIntervalMs = 5000 } = config;
  const controller = new AdaptivePollController({
    basePollIntervalMs: pollIntervalMs,
    maxEventsPerPage: config.eventsPerPage ?? 200,
    ...config.backpressure,
  });
  let decision = controller.current();

  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const result = await pollOnce({
        ...config,
        eventsPerPage: decision.eventsPerPage,
      });
      decision = controller.observe({
        durationMs: Date.now() - startedAt,
        eventsWritten: result.eventsWritten,
      });
    } catch (error) {
      decision = controller.observe({
        durationMs: Date.now() - startedAt,
        failed: true,
      });
      config.logger?.error("poll iteration failed", { error });
    }

    recordBackpressureState(decision);
    if (decision.shouldAlert) {
      config.logger?.warn("sustained indexer backpressure detected", {
        pollIntervalMs: decision.pollIntervalMs,
        eventsPerPage: decision.eventsPerPage,
        consecutivePressureSamples: decision.consecutivePressureSamples,
      });
    }

    if (signal.aborted) break;

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, decision.pollIntervalMs);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
