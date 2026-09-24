import { Networks, rpc } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadAggregatorConfig, type AggregatorConfig } from "./config.js";
import { createCorrelationId, createLogger, isValidRequestId, type Logger } from "../log.js";
import {
  loadOracleMetricsConfig,
  startOracleMetrics,
  type OracleMetricsRuntime,
} from "../metrics/index.js";
import {
  createAlertRouter,
  createWebhookAlertChannel,
  createWebhookAlertSender,
  createAmbiguousTallyAlertSender,
  type AlertChannel,
} from "./alert.js";
import {
  createPostgresNotificationStore,
  failedWebhookNotificationsTableSql,
} from "./finalize-notifier.js";
import { createPostgresSubmissionStore, computeTally } from "./tally.js";
import { CouncilVoteManager } from "./council-votes.js";
import { selectThresholdOutcome } from "./threshold.js";
import { assertCanFinalize, createBalancedValidationConfig } from "./submission-validator.js";
import { finalizeMarketDecision, queryMarketState, queryRegisteredResolvers } from "./market-finalizer.js";
import {
  compareCouncilResolvers,
  loadCouncilConfig,
  type CouncilConfig,
} from "../config/council.js";
import {
  AggregatorMetrics,
  AggregatorMetricsServer,
  createPostgresResolutionMetricStore,
} from "./metrics.js";


export {
  OracleMetricsCollector,
  OracleMetricsServer,
  ORACLE_METRICS_DEFAULT_PORT,
  collectOracleMetrics,
  loadOracleMetricsConfig,
  serializeOracleMetrics,
  startOracleMetrics,
  type OracleMetricsConfig,
  type OracleMetricsRuntime,
  type OracleMetricsSnapshot,
  type ResolutionLagSample,
} from "../metrics/index.js";

export { detectConflict, type ConflictReport } from "./conflict-detection.js";
export {
  buildAuditRecord,
  collectCouncilAudit,
  exportCouncilAudit,
  toAuditCsv,
  toAuditJson,
  type AuditFormat,
  type CouncilAuditInput,
  type CouncilAuditRecord,
} from "./council-audit.js";
export {
  notifyFinalized,
  type FinalizeNotification,
  type FinalizeNotifierOptions,
} from "./finalize-notifier.js";
export { detectStuckMarket, detectStuckMarkets, type StuckMarketAlert, type StuckMarketInput } from "./stuck-market.js";
export { ResolverKeyManager } from "./key-rotation.js";
export {
  AggregatorMetrics,
  AggregatorMetricsServer,
  DEFAULT_LAG_BUCKETS_HOURS,
  ORACLE_RESOLUTION_LAG_H_METRIC,
  createPostgresResolutionMetricStore,
  type AggregatorMetricsServerOptions,
  type AggregatorMetricsSnapshot,
  type NamedMetric,
  type ResolutionLagEntry,
} from "./metrics.js";
export {
  computeTally,
  createPostgresSubmissionStore,
  SubmissionTracker,
  type MarketTally,
  type SubmissionStore,
} from "./tally.js";
export {
  loadCouncilConfig,
  isCouncilMember,
  describeCouncilConfig,
  hasQuorum,
  meetsThreshold,
  COUNCIL_SIZE,
  COUNCIL_DEFAULT_THRESHOLD,
  type CouncilConfig,
} from "../config/council.js";
export {
  resolveMarketOnChain,
  createStellarSubmitter,
  type OnChainSubmitter,
  type ResolveMarketResult,
} from "../submitter/resolveMarket.js";
export { CouncilVoteManager } from "./council-votes.js";
export {
  MarketAlreadyFinalizedError,
  finalizeMarketDecision,
  queryMarketState,
  queryRegisteredResolvers,
} from "./market-finalizer.js";

export {
  OffChainSubmitterService,
  type DataAdapter,
  type OffChainSubmitterOptions,
  type OffChainSubmitterStore,
  type SubmittedOutcomeResult,
} from "../submitter/offChainSubmitter.js";
export {
  checkBondMinimum,
  checkBondMinimumFromDb,
  type BondAlert,
  type BondMonitorOptions,
  type OracleSubmissionRecord,
} from "./bond-monitor.js";
export {
  getBondDashboardData,
  type BondDashboardData,
} from "./dashboard.js";
export {
  reconcileBonds,
  runBondReconciliation,
  recordSettlement,
  type BondRefundDiscrepancy,
  type BondReconciliationOptions,
  type BondReconciliationResult,
  type BondSettlement,
  type RecordSettlementInput,
  type TerminalSubmission,
} from "./bond-reconciliation.js";
export {
  checkCouncilInactivity,
  checkCouncilInactivityFromDb,
  checkCouncilWindowExceeded,
  checkCouncilWindowExceededFromDb,
  type CouncilInactivityAlert,
  type CouncilWindowExceededAlert,
  type CouncilInactivityMonitorOptions,
  type EscalatedMarketRecord,
} from "./council-inactivity-monitor.js";
export { ChallengeBot, startChallengeBot, type ChallengeBotOptions, type OracleSubmission, type ChallengeDecision, type ChallengeResult } from "./challenge-bot.js";
export {
  detectNewSubmissions,
  SubmissionWatcher,
  type DetectNewSubmissionsResult,
  type NewSubmissionAlert,
  type SubmissionRecord,
  type SubmissionWatcherOptions,
} from "./submission-watcher.js";
export {
  detectDisputeEscalations,
  DisputeEscalationWatcher,
  type DetectDisputeEscalationsResult,
  type DisputeEscalationAlert,
  type DisputeEscalationRecord,
  type DisputeEscalationWatcherOptions,
} from "./dispute-escalation-watcher.js";
export {
  loadCategoryResolverConfig,
  getResolversForCategory,
  isAuthorizedResolverForCategory,
  describeCategoryResolverConfig,
  type CategoryResolverConfig,
  type MarketCategory,
  MARKET_CATEGORIES,
} from "./category-resolvers.js";
export {
  validateSubmissionData,
  assertCanFinalize,
  createDefaultValidationConfig,
  createStrictValidationConfig,
  createBalancedValidationConfig,
  type SubmissionValidationResult,
  type SubmissionValidationConfig,
} from "./submission-validator.js";

import {
  AggregatorHealthServer,
  type AggregatorHealthServerOptions,
  type DependencyCheckResult,
  type ReadinessCheckResult,
} from "./health.js";

export {
  AggregatorHealthServer,
  type AggregatorHealthServerOptions,
  type DependencyCheckResult,
  type ReadinessCheckResult,
};

export interface AggregatorMarket {
  id: string;
  cancelled: boolean;
  /** Market end time in Unix seconds; with `id`, the keyset cursor for paging. */
  endTime?: number;
}
/**
 * Tracing context for one attempt at processing one market (#467). The loop
 * creates it and passes it down explicitly rather than through async-local
 * storage, so every function that logs for the attempt visibly takes it.
 */
export interface ProcessMarketContext {
  /** Fresh per attempt; the same format as the backend's request ids. */
  correlationId: string;
  /** Bound to `correlationId` and `marketId`: every line it emits carries both. */
  logger?: Logger;
}

export interface AggregatorDependencies {
  connect(): Promise<void>;
  /**
   * Expired, unresolved markets ordered by (end_time, id). With `limit`, one
   * page of at most `limit` rows strictly after the `after` cursor (the last
   * market of the previous page). Keyset rather than OFFSET paging: markets
   * resolved while a poll is under way drop out of the result set, and an
   * offset into a shrinking set skips over rows that were never processed.
   */
  listExpiredUnresolvedMarkets(now: Date, limit?: number, after?: AggregatorMarket): Promise<AggregatorMarket[]>;
  getBacklogDepth?(now: Date): Promise<number>;
  checkReadiness?(): Promise<{ db: { ok: boolean; latencyMs?: number; error?: string }; rpc: { ok: boolean; latencyMs?: number; error?: string } }>;
  processMarket(market: AggregatorMarket, context?: ProcessMarketContext): Promise<void>;
  close(): Promise<void>;
}

export function createProductionDependencies(
  config: AggregatorConfig,
  logger: Logger = createLogger({ level: config.LOG_LEVEL }),
  overrides: {
    database?: Pool;
    server?: rpc.Server;
    fetchFn?: typeof fetch;
    council?: CouncilConfig;
    onAmbiguousTally?: (alert: { marketId: string; yesVotes: number; noVotes: number; threshold: number }) => Promise<void>;
  } = {},
): AggregatorDependencies {
  const database = overrides.database ?? new Pool({ connectionString: config.DATABASE_URL });
  const server = overrides.server ?? new rpc.Server(config.SOROBAN_RPC_URL);
  const councilVoteManager = new CouncilVoteManager(createPostgresSubmissionStore(database));
  const resolutionMetricStore = createPostgresResolutionMetricStore(database);
  const networkPassphrase = config.NETWORK_PASSPHRASE ?? Networks.TESTNET;
  const rootLogger = logger;
  let resolverSetMatches = overrides.council === undefined;

  // A stale council file should not take the whole oracle offline, but it must
  // never be allowed to submit a resolution that the contract will reject.
  async function refreshResolverSet(): Promise<void> {
    if (!overrides.council || !config.MARKET_CONTRACT_ID || !config.RESOLVER_KEY) {
      resolverSetMatches = true;
      return;
    }

    try {
      const onChainResolvers = await queryRegisteredResolvers(
        server,
        config.MARKET_CONTRACT_ID,
        config.RESOLVER_KEY,
        networkPassphrase,
      );
      const report = compareCouncilResolvers(overrides.council, onChainResolvers);
      resolverSetMatches = report.matches;
      if (!report.matches) {
        logger.error("council resolver configuration diverges from on-chain registry", {
          missingOnChain: report.missingOnChain,
          unconfiguredOnChain: report.unconfiguredOnChain,
        });
      } else {
        logger.info("council resolver configuration matches on-chain registry");
      }
    } catch (error) {
      resolverSetMatches = false;
      logger.warn("unable to validate council resolver configuration", { error });
    }
  }

  return {
    async connect() {
      await Promise.all([database.query("SELECT 1"), server.getLatestLedger()]);
      try {
        await database.query(failedWebhookNotificationsTableSql);
      } catch (err) {
        logger.warn("could not ensure failed_webhook_notifications table", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info("aggregator connected", { rpcUrl: config.SOROBAN_RPC_URL });
    },
    async listExpiredUnresolvedMarkets(now, limit, after) {
      await refreshResolverSet();
      const params: unknown[] = [Math.floor(now.getTime() / 1_000)];
      let sql = `SELECT id::text, cancelled, end_time FROM markets
         WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM oracle_ambiguous_tallies a
             WHERE a.market_id = markets.id AND a.status = 'manual_review'
           )`;

      if (limit !== undefined && limit > 0) {
        params.push(limit);
        if (after?.endTime !== undefined) {
          params.push(after.endTime, after.id);
          sql += ` AND (end_time, id) > ($3, $4)`;
        }
        sql += ` ORDER BY end_time ASC, id ASC LIMIT $2`;
      } else {
        sql += ` ORDER BY end_time ASC, id ASC`;
      }

      const result = await database.query<{
        id: string;
        cancelled: boolean;
        end_time: string | number;
      }>(sql, params);
      return result.rows.map((row) => ({
        id: row.id,
        cancelled: row.cancelled,
        endTime: Number(row.end_time),
      }));
    },
    async getBacklogDepth(now) {
      const result = await database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM markets
         WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM oracle_ambiguous_tallies a
             WHERE a.market_id = markets.id AND a.status = 'manual_review'
           )`,
        [Math.floor(now.getTime() / 1_000)],
      );
      return parseInt(result.rows[0]?.count ?? "0", 10);
    },
    async checkReadiness() {
      const startDb = Date.now();
      let dbRes: { ok: boolean; latencyMs?: number; error?: string };
      try {
        await database.query("SELECT 1");
        dbRes = { ok: true, latencyMs: Date.now() - startDb };
      } catch (err) {
        dbRes = { ok: false, latencyMs: Date.now() - startDb, error: err instanceof Error ? err.message : String(err) };
      }

      const startRpc = Date.now();
      let rpcRes: { ok: boolean; latencyMs?: number; error?: string };
      try {
        await server.getLatestLedger();
        rpcRes = { ok: true, latencyMs: Date.now() - startRpc };
      } catch (err) {
        rpcRes = { ok: false, latencyMs: Date.now() - startRpc, error: err instanceof Error ? err.message : String(err) };
      }

      return { db: dbRes, rpc: rpcRes };
    },
    async processMarket(market, context) {
      const marketId = market.id.trim();
      const correlationId = context?.correlationId ?? createCorrelationId();
      let marketLogger = context?.logger ?? rootLogger.child({ correlationId, marketId });

      if (!resolverSetMatches) {
        throw new Error("council resolver configuration does not match the on-chain registry");
      }

      if (market.cancelled) {
        marketLogger.info("market is cancelled, skipping", { marketId });
        return;
      }

      const onChainMarketId = Number(marketId);
      if (!Number.isSafeInteger(onChainMarketId) || onChainMarketId < 0) {
        marketLogger.error("market id is not a non-negative integer, skipping", { marketId });
        return;
      }

      if (!config.MARKET_CONTRACT_ID || !config.RESOLVER_KEY) {
        marketLogger.error("aggregator is not configured for finalization, skipping", {
          marketId,
          hasMarketContractId: Boolean(config.MARKET_CONTRACT_ID),
          hasResolverKey: Boolean(config.RESOLVER_KEY),
        });
        return;
      }

      const state = await queryMarketState(
        server,
        config.MARKET_CONTRACT_ID,
        onChainMarketId,
        config.RESOLVER_KEY,
        networkPassphrase,
      );
      if (state.cancelled) {
        marketLogger.info("market is cancelled on-chain, skipping", { marketId });
        return;
      }
      if (state.resolved) {
        marketLogger.info("market is already resolved on-chain, skipping", { marketId });
        return;
      }

      const origin = await database.query<{ request_id: string | null }>(
        "SELECT request_id FROM oracle_submissions WHERE market_id = $1 AND request_id IS NOT NULL",
        [onChainMarketId],
      );
      const originRequestId = origin.rows
        .map((row) => row.request_id)
        .find((id): id is string => isValidRequestId(id));
      if (originRequestId) {
        marketLogger = marketLogger.child({ originRequestId });
        marketLogger.info("correlated with originating backend request");
      }

      const tally = await councilVoteManager.getTallyFromStore(marketId);
      marketLogger.info("computed tally", {
        marketId,
        yesVotes: tally.yesVotes,
        noVotes: tally.noVotes,
        totalVoters: tally.totalVoters,
      });

      const outcome = selectThresholdOutcome(
        tally.votes,
        config.COUNCIL_THRESHOLD,
        marketLogger,
        marketId,
      );

      if (outcome === null) {
        const recorded = await database.query(
          `INSERT INTO oracle_ambiguous_tallies (market_id, yes_votes, no_votes, threshold)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (market_id) DO UPDATE
             SET status = 'manual_review',
                 yes_votes = EXCLUDED.yes_votes,
                 no_votes = EXCLUDED.no_votes,
                 threshold = EXCLUDED.threshold,
                 last_seen_at = NOW(),
                 alert_claimed_at = NOW()
           WHERE oracle_ambiguous_tallies.status = 'cleared'
           RETURNING market_id`,
          [marketId, tally.yesVotes, tally.noVotes, config.COUNCIL_THRESHOLD],
        );
        marketLogger.error("ambiguous council tally, market held for manual review", {
          marketId,
          yesVotes: tally.yesVotes,
          noVotes: tally.noVotes,
          threshold: config.COUNCIL_THRESHOLD,
        });
        if (recorded.rows.length > 0) {
          await overrides.onAmbiguousTally?.({
            marketId,
            yesVotes: tally.yesVotes,
            noVotes: tally.noVotes,
            threshold: config.COUNCIL_THRESHOLD,
          });
        }
        return;
      }

      assertCanFinalize(
        marketId,
        tally,
        createBalancedValidationConfig(config.COUNCIL_THRESHOLD),
      );

      marketLogger.info("threshold met, finalizing market", { marketId, decision: outcome });
      const txHash = await finalizeMarketDecision(
        database,
        server,
        config.MARKET_CONTRACT_ID,
        config.RESOLVER_KEY,
        onChainMarketId,
        outcome,
        [...tally.votes],
        networkPassphrase,
        {
          webhookUrl: config.FINALIZE_WEBHOOK_URL,
          webhookSigningSecret: config.WEBHOOK_SIGNING_SECRET,
          maxAttempts: config.FINALIZE_WEBHOOK_MAX_ATTEMPTS,
          store: createPostgresNotificationStore(database),
          fetchFn: overrides.fetchFn,
          logger: marketLogger,
        },
        (finalizedAt) => {
          const resolvedAt = Math.floor(finalizedAt.getTime() / 1_000);
          const lagHours = (resolvedAt - state.endTime) / 3_600;
          void resolutionMetricStore
            .recordResolution({ marketId, endTime: state.endTime, resolvedAt, lagHours })
            .catch((error: unknown) => {
              marketLogger.warn("failed to persist resolution metric", { marketId, error });
            });
        },
        { correlationId, originRequestId, logger: marketLogger },
      );
      marketLogger.info("market finalized", { marketId, decision: outcome, txHash });
    },
    async close() {
      await database.end();
      logger.info("aggregator stopped");
    },
  };
}

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

export async function startAggregator(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadAggregatorConfig(env);
  const logger = createLogger({ level: config.LOG_LEVEL, bindings: { service: "oracle-aggregator" } });
  const councilConfig = loadCouncilConfig(env);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  let metrics: OracleMetricsRuntime | undefined;
  let aggMetricsServer: AggregatorMetricsServer | undefined;
  let healthServer: AggregatorHealthServer | undefined;
  let lastPollCompletedAt: number | null = null;
  const aggregatorMetrics = new AggregatorMetrics();

  const dependencies = createProductionDependencies(config, logger, {
    council: councilConfig,
    onAmbiguousTally: createAmbiguousTallyAlertSender(config.FINALIZE_WEBHOOK_URL, logger),
  });

  try {
    try {
      metrics = await startOracleMetrics({
        config: loadOracleMetricsConfig(env),
        databaseUrl: config.DATABASE_URL,
        logger,
      });
    } catch (error) {
      logger.error("oracle metrics endpoint failed to start", { error });
    }

    try {
      aggMetricsServer = new AggregatorMetricsServer({
        metrics: aggregatorMetrics,
        port: Number(process.env.AGGREGATOR_METRICS_PORT ?? 9102),
        host: process.env.AGGREGATOR_METRICS_HOST ?? "0.0.0.0",
      });
      await aggMetricsServer.start();
      logger.info("aggregator prometheus metrics server started", { port: 9102 });
    } catch (error) {
      logger.error("aggregator prometheus metrics server failed to start", { error });
    }

    if (config.HEALTH_ENABLED) {
      try {
        healthServer = new AggregatorHealthServer({
          port: config.HEALTH_PORT,
          host: config.HEALTH_HOST,
          maxStaleMs: config.MAX_POLL_STALE_MS,
          getLastPollCompletedAt: () => lastPollCompletedAt,
          checkReadiness: async () => {
            if (dependencies.checkReadiness) {
              return dependencies.checkReadiness();
            }
            return {
              db: { ok: true },
              rpc: { ok: true },
            };
          },
          logger,
        });
        await healthServer.start();
      } catch (error) {
        logger.error("oracle health endpoint failed to start", { error });
      }
    }

    // Issue #462: build the multi-channel alert router with cooldown and routing.
    const alertChannels: AlertChannel[] = [];
    if (config.ALERT_WEBHOOK_URL) {
      alertChannels.push(
        createWebhookAlertChannel({
          name: "webhook",
          webhookUrl: config.ALERT_WEBHOOK_URL,
          minSeverity: "SEV3",
          logger,
        }),
      );
    }
    const alertSender = createAlertRouter({
      channels: alertChannels,
      logger,
      cooldownMs: config.ALERT_COOLDOWN_MS,
    });

    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      batchSize: config.AGGREGATOR_BATCH_SIZE,
      logger,
      alertSender,
      metrics: aggregatorMetrics,
      shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
      onIterationComplete: (timestamp) => {
        lastPollCompletedAt = timestamp;
      },
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await healthServer?.stop();
    await aggMetricsServer?.stop();
    await metrics?.stop();
  }
}
