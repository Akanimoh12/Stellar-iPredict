import { rpc } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadAggregatorConfig, type AggregatorConfig } from "./config.js";
import { createLogger, type Logger } from "../log.js";

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
export { AggregatorMetrics, type ResolutionLagEntry, type AggregatorMetricsSnapshot } from "./metrics.js";
export {
  computeTally,
  createPostgresSubmissionStore,
  SubmissionTracker,
  type MarketTally,
  type SubmissionStore,
} from "./tally.js";
export { loadCouncilConfig, isCouncilMember, describeCouncilConfig, type CouncilConfig } from "../config/council.js";
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
  checkCouncilInactivity,
  checkCouncilInactivityFromDb,
  type CouncilInactivityAlert,
  type CouncilInactivityMonitorOptions,
  type EscalatedMarketRecord,
} from "./council-inactivity-monitor.js";
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
  options: { signal: AbortSignal; pollIntervalMs: number; logger?: Logger },
): Promise<void> {
  const logger = options.logger;
  await dependencies.connect();
  try {
    while (!options.signal.aborted) {
      const startedAt = Date.now();
      const markets = await dependencies.listExpiredUnresolvedMarkets(new Date());
      for (const market of markets) {
        if (options.signal.aborted) break;
        await dependencies.processMarket(market);
      }
      logger?.info("poll iteration complete", {
        marketsChecked: markets.length,
        durationMs: Date.now() - startedAt,
      });
      if (!options.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollIntervalMs);
          options.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
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
  try {
    await runAggregator(createProductionDependencies(config, logger), {
      signal: controller.signal,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      logger,
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
