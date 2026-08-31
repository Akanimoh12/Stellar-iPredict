import { Networks, rpc } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadAggregatorConfig, type AggregatorConfig } from "./config.js";
import { createLogger, type Logger } from "../log.js";
import {
  loadOracleMetricsConfig,
  startOracleMetrics,
  type OracleMetricsRuntime,
} from "../metrics/index.js";
import { createPostgresSubmissionStore, computeTally } from "./tally.js";
import { selectThresholdOutcome } from "./threshold.js";
import { assertCanFinalize, createBalancedValidationConfig } from "./submission-validator.js";
import { finalizeMarketDecision, queryMarketState } from "./market-finalizer.js";


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

export interface AggregatorMarket { id: string; cancelled: boolean; }
export interface AggregatorDependencies {
  connect(): Promise<void>;
  listExpiredUnresolvedMarkets(now: Date, limit?: number, offset?: number): Promise<AggregatorMarket[]>;
  getBacklogDepth?(now: Date): Promise<number>;
  checkReadiness?(): Promise<{ db: { ok: boolean; latencyMs?: number; error?: string }; rpc: { ok: boolean; latencyMs?: number; error?: string } }>;
  processMarket(market: AggregatorMarket): Promise<void>;
  close(): Promise<void>;
}

export function createProductionDependencies(
  config: AggregatorConfig,
  logger: Logger = createLogger({ level: config.LOG_LEVEL }),
  overrides: { database?: Pool; server?: rpc.Server } = {},
): AggregatorDependencies {
  const database = overrides.database ?? new Pool({ connectionString: config.DATABASE_URL });
  const server = overrides.server ?? new rpc.Server(config.SOROBAN_RPC_URL);
  const submissionStore = createPostgresSubmissionStore(database);
  const networkPassphrase = config.NETWORK_PASSPHRASE ?? Networks.TESTNET;
  return {
    async connect() {
      await Promise.all([database.query("SELECT 1"), server.getLatestLedger()]);
      logger.info("aggregator connected", { rpcUrl: config.SOROBAN_RPC_URL });
    },
    async listExpiredUnresolvedMarkets(now, limit, offset = 0) {
      if (limit !== undefined && limit > 0) {
        const result = await database.query<AggregatorMarket>(
          `SELECT id::text, cancelled FROM markets
           WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE
           ORDER BY end_time ASC, id ASC
           LIMIT $2 OFFSET $3`,
          [Math.floor(now.getTime() / 1_000), limit, offset],
        );
        return result.rows;
      }
      const result = await database.query<AggregatorMarket>(
        `SELECT id::text, cancelled FROM markets
         WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE
         ORDER BY end_time ASC, id ASC`,
        [Math.floor(now.getTime() / 1_000)],
      );
      return result.rows;
    },
    async getBacklogDepth(now) {
      const result = await database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM markets
         WHERE end_time <= $1 AND resolved = FALSE AND cancelled = FALSE`,
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
      async processMarket(market) {
      // Handles exactly one market so a failure here cannot stop the poll loop
      // from moving on to the remaining expired markets.
      const marketId = market.id.trim();
      try {
        // Defensive: the expiry query already filters these out, but a market
        // can be cancelled or resolved between the query and this call.
        if (market.cancelled) {
          logger.info("market is cancelled, skipping", { marketId });
          return;
        }

        // The on-chain and finalizer APIs take a numeric market id.
        const onChainMarketId = Number(marketId);
        if (!Number.isSafeInteger(onChainMarketId) || onChainMarketId < 0) {
          logger.error("market id is not a non-negative integer, skipping", { marketId });
          return;
        }

        if (!config.MARKET_CONTRACT_ID || !config.RESOLVER_KEY) {
          logger.error("aggregator is not configured for finalization, skipping", {
            marketId,
            hasMarketContractId: Boolean(config.MARKET_CONTRACT_ID),
            hasResolverKey: Boolean(config.RESOLVER_KEY),
          });
          return;
        }

        // 1. On-chain state — never finalize a market that is already resolved
        //    or cancelled on the contract, regardless of the DB view.
        const state = await queryMarketState(
          server,
          config.MARKET_CONTRACT_ID,
          onChainMarketId,
          config.RESOLVER_KEY,
          networkPassphrase,
        );
        if (state.cancelled) {
          logger.info("market is cancelled on-chain, skipping", { marketId });
          return;
        }
        if (state.resolved) {
          logger.info("market is already resolved on-chain, skipping", { marketId });
          return;
        }

        // 2. Load the council's current submissions and compute the tally.
        const votes = await submissionStore.getSubmissions(marketId);
        const tally = computeTally(marketId, votes);
        logger.info("computed tally", {
          marketId,
          yesVotes: tally.yesVotes,
          noVotes: tally.noVotes,
          totalVoters: tally.totalVoters,
        });

        // 3. Evaluate the threshold. `null` means no outcome (or an ambiguous
        //    both-outcomes) majority — the market stays untouched this poll.
        const outcome = selectThresholdOutcome(votes, config.COUNCIL_THRESHOLD, logger, marketId);
        if (outcome === null) {
          logger.warn("threshold not met, market left unresolved", {
            marketId,
            yesVotes: tally.yesVotes,
            noVotes: tally.noVotes,
            threshold: config.COUNCIL_THRESHOLD,
          });
          return;
        }

        // 4. Safety gate — assertCanFinalize throws with a descriptive reason
        //    if submissions are insufficient or the tally is ambiguous.
        assertCanFinalize(marketId, tally, createBalancedValidationConfig(config.COUNCIL_THRESHOLD));

        // 5. Finalize on-chain and persist the decision.
        logger.info("threshold met, finalizing market", { marketId, decision: outcome });
        const txHash = await finalizeMarketDecision(
          database,
          server,
          config.MARKET_CONTRACT_ID,
          config.RESOLVER_KEY,
          onChainMarketId,
          outcome,
          [...tally.votes],
          networkPassphrase,
        );
        logger.info("market finalized", { marketId, decision: outcome, txHash });
      } catch (error) {
        logger.error("failed to process market", {
          marketId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async close() {
      await database.end();
      logger.info("aggregator stopped");
    },
  };
}

export async function runAggregator(
  dependencies: AggregatorDependencies,
  options: {
    signal: AbortSignal;
    pollIntervalMs: number;
    batchSize?: number;
    logger?: Logger;
    onIterationComplete?: (timestamp: number) => void;
  },
): Promise<void> {
  const logger = options.logger;
  await dependencies.connect();
  try {
    while (!options.signal.aborted) {
      const startedAt = Date.now();
      const now = new Date();
      const backlogDepth = dependencies.getBacklogDepth ? await dependencies.getBacklogDepth(now) : undefined;
      
      let marketsChecked = 0;
      let offset = 0;
      const batchSize = options.batchSize;

      for (;;) {
        if (options.signal.aborted) break;

        const batch = await dependencies.listExpiredUnresolvedMarkets(now, batchSize, offset);
        if (batch.length === 0) break;

        for (const market of batch) {
          if (options.signal.aborted) break;
          try {
            await dependencies.processMarket(market);
          } catch (error) {
            logger?.error("error processing market in aggregator poll", {
              marketId: market.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          marketsChecked += 1;
        }

        if (batchSize === undefined || batchSize <= 0 || batch.length < batchSize) {
          break;
        }
        offset += batchSize;
      }

      const completedAt = Date.now();
      options.onIterationComplete?.(completedAt);

      logger?.info("poll iteration complete", {
        marketsChecked,
        backlogDepth,
        durationMs: completedAt - startedAt,
      });

      if (!options.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollIntervalMs);
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
  let healthServer: AggregatorHealthServer | undefined;
  let lastPollCompletedAt: number | null = null;

  const dependencies = createProductionDependencies(config, logger);

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

    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      batchSize: config.AGGREGATOR_BATCH_SIZE,
      logger,
      onIterationComplete: (timestamp) => {
        lastPollCompletedAt = timestamp;
      },
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await healthServer?.stop();
    await metrics?.stop();
  }
}
