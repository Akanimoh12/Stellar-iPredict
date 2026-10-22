import { rpc } from "@stellar/stellar-sdk";
import { parseExpectedWasmHashes, verifyContractWasm } from "@ipredict/shared";
import { loadAggregatorConfig } from "./config.js";
import { createLogger } from "../log.js";
import {
  loadOracleMetricsConfig,
  startOracleMetrics,
  type OracleMetricsRuntime,
} from "../metrics/index.js";
import {
  createAlertRouter,
  createWebhookAlertChannel,
  createAmbiguousTallyAlertSender,
  type AlertChannel,
} from "./alert.js";
import { loadCouncilConfig } from "../config/council.js";
import { AggregatorMetrics, AggregatorMetricsServer } from "./metrics.js";
import { AggregatorHealthServer } from "./health.js";
import { alertContractWasmResults } from "./wasm-integrity.js";
import { createProductionDependencies } from "./runner-dependencies.js";
import { runAggregator } from "./runner-loop.js";

export async function startAggregator(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadAggregatorConfig(env);
  const logger = createLogger({ level: config.LOG_LEVEL, bindings: { service: "oracle-aggregator" } });
  const councilConfig = loadCouncilConfig(env);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Issue #610: confirm the market contract still runs the audited build.
  // Parsed up front so a malformed EXPECTED_WASM_HASHES fails startup; the RPC
  // check itself runs in the background so a slow node cannot delay startup.
  const expectedWasm = parseExpectedWasmHashes(config.EXPECTED_WASM_HASHES);
  const marketContractId = config.MARKET_CONTRACT_ID;
  if (marketContractId) {
    const rpcServer = new rpc.Server(config.SOROBAN_RPC_URL);
    verifyContractWasm({
      contractIds: [marketContractId],
      expected: expectedWasm,
      fetchWasm: (id) => rpcServer.getContractWasmByContractId(id),
    })
      .then((results) => alertContractWasmResults(results, config.ALERT_WEBHOOK_URL, logger))
      .catch((error) => logger.warn("contract wasm hash could not be verified", { error }));
  }

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
