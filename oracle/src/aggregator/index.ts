import { rpc } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadAggregatorConfig, type AggregatorConfig } from "./config.js";
import { createLogger, type Logger } from "../log.js";
import {
  loadOracleMetricsConfig,
  startOracleMetrics,
  type OracleMetricsRuntime,
} from "../metrics/index.js";
import { createWebhookAlertSender } from "./alert.js";

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
  ORACLE_RESOLUTION_LAG_H_METRIC,
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
export { MarketAlreadyFinalizedError, finalizeMarketDecision, queryMarketState } from "./market-finalizer.js";

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

export interface AggregatorMarket { id: string; cancelled: boolean; }
export interface AggregatorDependencies {
  connect(): Promise<void>;
  listExpiredUnresolvedMarkets(now: Date): Promise<AggregatorMarket[]>;
  processMarket(market: AggregatorMarket): Promise<void>;
  close(): Promise<void>;
}

export function createProductionDependencies(
  config: AggregatorConfig,
  logger: Logger = createLogger({ level: config.LOG_LEVEL }),
): AggregatorDependencies {
  const database = new Pool({ connectionString: config.DATABASE_URL });
  const server = new rpc.Server(config.SOROBAN_RPC_URL);
  return {
    async connect() {
      await Promise.all([database.query("SELECT 1"), server.getLatestLedger()]);
      logger.info("aggregator connected", { rpcUrl: config.SOROBAN_RPC_URL });
    },
    async listExpiredUnresolvedMarkets(now) {
      const result = await database.query<AggregatorMarket>(
        `SELECT id::text, cancelled FROM markets
         WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE
         ORDER BY end_time ASC`,
        [Math.floor(now.getTime() / 1_000)],
      );
      return result.rows;
    },
    async processMarket() {
      // Threshold evaluation and finalization are composed by follow-up modules.
    },
    async close() {
      await database.end();
      logger.info("aggregator stopped");
    },
  };
}

export async function runAggregator(
  dependencies: AggregatorDependencies,
  options: { signal: AbortSignal; pollIntervalMs: number; logger?: Logger; alertSender?: (alert: any) => Promise<void> },
): Promise<void> {
  const logger = options.logger;
  const alertSender = options.alertSender;
  const marketFailureMap = new Map<string, number>(); // Track consecutive failures per market
  const FAILURE_THRESHOLD = 5; // Escalate after 5 consecutive failures

  await dependencies.connect();
  try {
    while (!options.signal.aborted) {
      const startedAt = Date.now();
      const markets = await dependencies.listExpiredUnresolvedMarkets(new Date());
      let marketsProcessed = 0;

      for (const market of markets) {
        if (options.signal.aborted) break;

        try {
          await dependencies.processMarket(market);
          // Reset failure count on success
          marketFailureMap.delete(market.id);
          marketsProcessed++;
        } catch (error) {
          const failureCount = (marketFailureMap.get(market.id) ?? 0) + 1;
          marketFailureMap.set(market.id, failureCount);

          logger?.error("market processing failed", {
            marketId: market.id,
            error,
            consecutiveFailures: failureCount,
          });

          // Escalate after threshold
          if (failureCount >= FAILURE_THRESHOLD && alertSender) {
            try {
              await alertSender({
                marketId: market.id,
                attempts: failureCount,
                error,
              });
            } catch (alertError) {
              logger?.error("failed to send failure alert", {
                marketId: market.id,
                alertError,
              });
            }
          }

          // Continue to next market instead of failing the entire loop
        }
      }

      const iterationDurationMs = Date.now() - startedAt;
      logger?.info("poll iteration complete", {
        marketsChecked: markets.length,
        marketsProcessed,
        durationMs: iterationDurationMs,
      });

      if (!options.signal.aborted) {
        // Calculate adjusted sleep to maintain consistent poll interval
        // Issue #448: Prevent interval drift by subtracting iteration duration
        const adjustedSleepMs = Math.max(0, options.pollIntervalMs - iterationDurationMs);

        if (adjustedSleepMs < options.pollIntervalMs && iterationDurationMs > options.pollIntervalMs) {
          logger?.warn("poll iteration overran configured interval", {
            configuredIntervalMs: options.pollIntervalMs,
            iterationDurationMs,
            nextPollImmediately: true,
          });
        }

        if (adjustedSleepMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, adjustedSleepMs);
            options.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
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
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  let metrics: OracleMetricsRuntime | undefined;
  try {
    // Prometheus endpoint (issue #211). The aggregator hosts it rather than
    // the monitor because `infra/prometheus/prometheus.yml` scrapes one oracle
    // target, and because the aggregator is the service whose absence is worth
    // alerting on. Started before the poll loop so a scrape during a slow first
    // connect still answers.
    //
    // A failure here — almost always a port already in use — is logged and the
    // aggregator carries on without the endpoint. Refusing to resolve markets
    // because a metrics port is taken would trade a monitoring outage for a
    // real one; the `ipredict-oracle` scrape target going DOWN is exactly the
    // signal an operator needs, and it costs nothing.
    try {
      metrics = await startOracleMetrics({
        config: loadOracleMetricsConfig(env),
        databaseUrl: config.DATABASE_URL,
        logger,
      });
    } catch (error) {
      logger.error("oracle metrics endpoint failed to start", { error });
    }

    await runAggregator(createProductionDependencies(config, logger), {
      signal: controller.signal,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      logger,
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await metrics?.stop();
  }
}
