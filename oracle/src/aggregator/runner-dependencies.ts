import { Networks, rpc } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import type { AggregatorConfig } from "./config.js";
import { createCorrelationId, createLogger, isValidRequestId, type Logger } from "../log.js";
import {
  createPostgresNotificationStore,
  failedWebhookNotificationsTableSql,
} from "./finalize-notifier.js";
import { createPostgresSubmissionStore } from "./tally.js";
import { CouncilVoteManager } from "./council-votes.js";
import { selectThresholdOutcome } from "./threshold.js";
import { assertCanFinalize, createBalancedValidationConfig } from "./submission-validator.js";
import { finalizeMarketDecision, queryMarketState, queryRegisteredResolvers } from "./market-finalizer.js";
import {
  compareCouncilResolvers,
  type CouncilConfig,
} from "../config/council.js";
import { createPostgresResolutionMetricStore } from "./metrics.js";

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
