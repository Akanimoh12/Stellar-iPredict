import { createCorrelationId, type Logger } from "../log.js";
import { AggregatorMetrics } from "./metrics.js";
import type {
  AggregatorDependencies,
  AggregatorMarket,
  ProcessMarketContext,
} from "./runner-dependencies.js";

/**
 * Time source for the poll loop. The loop is timing driven, so tests inject a
 * virtual clock to run many iterations deterministically instead of sleeping
 * for real (#468).
 */
export interface AggregatorClock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: AggregatorClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
};

export interface RunAggregatorOptions {
  signal: AbortSignal;
  pollIntervalMs: number;
  batchSize?: number;
  logger?: Logger;
  alertSender?: (alert: any) => Promise<void>;
  onIterationComplete?: (timestamp: number) => void;
  metrics?: AggregatorMetrics;
  /** Maximum time to let the current market finish after shutdown is requested. */
  shutdownGraceMs?: number;
  /** Defaults to {@link systemClock}. */
  clock?: AggregatorClock;
}

export class ShutdownGracePeriodExceededError extends Error {
  constructor(public readonly marketId: string, public readonly graceMs: number) {
    super(`Shutdown grace period exceeded while processing market ${marketId} after ${graceMs}ms`);
    this.name = "ShutdownGracePeriodExceededError";
  }
}

async function drainInFlightMarket(
  work: Promise<void>,
  signal: AbortSignal,
  graceMs: number,
  marketId: string,
  logger?: Logger,
): Promise<void> {
  const settled = work.then(
    () => ({ kind: "done" as const }),
    (error) => ({ kind: "error" as const, error }),
  );

  if (!signal.aborted) {
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
    });
    const first = await Promise.race([settled, aborted]);
    if (first.kind === "done") return;
    if (first.kind === "error") throw first.error;
  }

  logger?.info("shutdown requested; draining in-flight market", { marketId, graceMs });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), graceMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  if (result.kind === "done") return;
  if (result.kind === "error") throw result.error;

  logger?.error("shutdown grace period exceeded", { marketId, graceMs });
  throw new ShutdownGracePeriodExceededError(marketId, graceMs);
}

export async function runAggregator(
  dependencies: AggregatorDependencies,
  options: RunAggregatorOptions,
): Promise<void> {
  const logger = options.logger;
  const alertSender = options.alertSender;
  const marketFailureMap = new Map<string, number>(); // Track consecutive failures per market
  const FAILURE_THRESHOLD = 5; // Escalate after 5 consecutive failures
  const clock = options.clock ?? systemClock;
  const shutdownGraceMs = options.shutdownGraceMs ?? 20_000;

  await dependencies.connect();
  try {
    while (!options.signal.aborted) {
      const startedAt = clock.now();
      const now = new Date(startedAt);
      const backlogDepth = dependencies.getBacklogDepth
        ? await dependencies.getBacklogDepth(now)
        : undefined;

      let marketsChecked = 0;
      let marketsProcessed = 0;
      let after: AggregatorMarket | undefined;
      const batchSize = options.batchSize;

      for (;;) {
        if (options.signal.aborted) break;

        const batch = await dependencies.listExpiredUnresolvedMarkets(now, batchSize, after);
        if (batch.length === 0) break;

        for (const market of batch) {
          if (options.signal.aborted) break;
          options.metrics?.recordMarketProcessed();

          // One id per attempt, so a retry on the next poll is its own story.
          const correlationId = createCorrelationId();
          const marketLogger = logger?.child({ correlationId, marketId: market.id });

          try {
            await drainInFlightMarket(
              dependencies.processMarket(market, { correlationId, logger: marketLogger }),
              options.signal,
              shutdownGraceMs,
              market.id,
              marketLogger,
            );
            marketFailureMap.delete(market.id);
            marketsProcessed++;
            options.metrics?.recordMarketFinalized();
          } catch (error) {
            options.metrics?.recordMarketFailed();
            const failureCount = (marketFailureMap.get(market.id) ?? 0) + 1;
            marketFailureMap.set(market.id, failureCount);

            marketLogger?.error("market processing failed", {
              marketId: market.id,
              error,
              consecutiveFailures: failureCount,
            });

            if (failureCount >= FAILURE_THRESHOLD && alertSender) {
              try {
                await alertSender({
                  marketId: market.id,
                  attempts: failureCount,
                  error,
                  correlationId,
                });
              } catch (alertError) {
                marketLogger?.error("failed to send failure alert", {
                  marketId: market.id,
                  alertError,
                });
              }
            }
          }
          marketsChecked += 1;
        }

        if (batchSize === undefined || batchSize <= 0 || batch.length < batchSize) {
          break;
        }
        after = batch[batch.length - 1];
      }

      const completedAt = clock.now();
      options.onIterationComplete?.(completedAt);
      options.metrics?.recordPollCompleted(completedAt);

      const iterationDurationMs = completedAt - startedAt;
      logger?.info("poll iteration complete", {
        marketsChecked,
        marketsProcessed,
        backlogDepth,
        durationMs: iterationDurationMs,
      });

      if (!options.signal.aborted) {
        const adjustedSleepMs = Math.max(0, options.pollIntervalMs - iterationDurationMs);

        if (adjustedSleepMs < options.pollIntervalMs && iterationDurationMs > options.pollIntervalMs) {
          logger?.warn("poll iteration overran configured interval", {
            configuredIntervalMs: options.pollIntervalMs,
            iterationDurationMs,
            nextPollImmediately: true,
          });
        }

        if (adjustedSleepMs > 0) {
          await clock.sleep(adjustedSleepMs, options.signal);
        }
      }
    }
  } finally {
    await dependencies.close();
  }
}
