import { rpc } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadAggregatorConfig, type AggregatorConfig } from "./config.js";
import { EndpointPool } from "../rpc/endpoint-pool.js";

export { detectConflict, type ConflictReport } from "./conflict-detection.js";
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

export interface AggregatorMarket { id: string; cancelled: boolean; }
export interface AggregatorDependencies {
  connect(): Promise<void>;
  listExpiredUnresolvedMarkets(now: Date): Promise<AggregatorMarket[]>;
  processMarket(market: AggregatorMarket): Promise<void>;
  close(): Promise<void>;
}

export function createProductionDependencies(config: AggregatorConfig): AggregatorDependencies {
  const database = new Pool({ connectionString: config.DATABASE_URL });
  
  // Use endpoint pool for RPC failover if multiple endpoints configured
  const rpcEndpoints = config.SOROBAN_RPC_ENDPOINTS;
  const pool = rpcEndpoints.length > 1 
    ? new EndpointPool({ endpoints: rpcEndpoints })
    : null;
  
  // Use first endpoint for direct access (single-endpoint case)
  const server = new rpc.Server(rpcEndpoints[0]);
  
  return {
    async connect() {
      // Health check: verify DB and RPC connectivity
      if (pool) {
        // Multi-endpoint: use pool with failover
        await Promise.all([
          database.query("SELECT 1"),
          pool.withFailover(async (srv) => await srv.getLatestLedger()),
        ]);
      } else {
        // Single endpoint: direct connection
        await Promise.all([
          database.query("SELECT 1"),
          server.getLatestLedger(),
        ]);
      }
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
      if (pool) {
        pool.stop();
      }
    },
  };
}

export async function runAggregator(
  dependencies: AggregatorDependencies,
  options: { signal: AbortSignal; pollIntervalMs: number },
): Promise<void> {
  await dependencies.connect();
  try {
    while (!options.signal.aborted) {
      const markets = await dependencies.listExpiredUnresolvedMarkets(new Date());
      for (const market of markets) {
        if (options.signal.aborted) break;
        await dependencies.processMarket(market);
      }
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
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runAggregator(createProductionDependencies(config), {
      signal: controller.signal,
      pollIntervalMs: config.POLL_INTERVAL_MS,
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
