/**
 * Oracle metrics — the Prometheus endpoint half of oracle observability
 * (issue #211).
 *
 * ```ts
 * const runtime = await startOracleMetrics({
 *   config: loadOracleMetricsConfig(),
 *   databaseUrl: config.DATABASE_URL,
 *   logger,
 * });
 * // ... GET http://localhost:9101/metrics
 * await runtime.stop();
 * ```
 *
 * See `infra/README.md#prometheus-metrics-and-alerts` for the scrape config
 * and the metric catalogue.
 */

export {
  EMPTY_SNAPSHOT,
  OracleMetricsCollector,
  collectOracleMetrics,
  collectResolutionLag,
  countDisputes,
  countSubmissions,
  type MetricsCollectorOptions,
  type OracleMetricsSnapshot,
  type ResolutionLagSample,
} from "./collector.js";

export {
  ORACLE_METRICS_DEFAULT_PORT,
  loadOracleMetricsConfig,
  type OracleMetricsConfig,
} from "./config.js";

export { serializeOracleMetrics } from "./serialize.js";

export {
  OracleMetricsServer,
  startOracleMetrics,
  type OracleMetricsRuntime,
  type OracleMetricsServerOptions,
  type StartOracleMetricsOptions,
} from "./server.js";
