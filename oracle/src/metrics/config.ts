import { z } from "zod";

/**
 * Port the oracle metrics endpoint listens on.
 *
 * 9101 is not arbitrary: `infra/prometheus/prometheus.yml` has had an
 * `ipredict-oracle` job pre-provisioned against `host.docker.internal:9101`
 * since issue #222, waiting for this endpoint to exist. Changing the default
 * here means changing that scrape config too.
 */
export const ORACLE_METRICS_DEFAULT_PORT = 9_101;

const positiveInteger = z.coerce.number().int().positive();

/**
 * `.env` files spell booleans several ways. Anything unrecognised is a
 * configuration error rather than a silent `false` — "I disabled metrics by
 * accident" and "metrics are on" look identical from the outside otherwise.
 */
const booleanish = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalised = value.trim().toLowerCase();
  if (normalised === "") return undefined;
  if (["1", "true", "yes", "on"].includes(normalised)) return true;
  if (["0", "false", "no", "off"].includes(normalised)) return false;
  return normalised;
}, z.boolean());

const schema = z.object({
  /** Set to false to run the aggregator with no HTTP listener at all. */
  ORACLE_METRICS_ENABLED: booleanish.default(true),

  ORACLE_METRICS_PORT: positiveInteger.max(65_535).default(ORACLE_METRICS_DEFAULT_PORT),

  /**
   * 0.0.0.0 so a containerised Prometheus can reach a host-run oracle through
   * `host.docker.internal` — the same reason the indexer binds it
   * (`indexer/src/metrics-server.ts`). Set 127.0.0.1 to keep it host-local.
   */
  ORACLE_METRICS_HOST: z.string().min(1).default("0.0.0.0"),

  /**
   * How often the collector re-reads Postgres. Scrapes are served from the
   * cached snapshot, so a slow query never stalls a scrape — it only makes the
   * numbers older, which `oracle_metrics_last_refresh_timestamp_seconds` makes
   * visible instead of hiding.
   */
  ORACLE_METRICS_REFRESH_MS: positiveInteger.default(15_000),

  /**
   * Upper bound on `oracle_resolution_lag_h` series per scrape.
   *
   * The gauge is labelled by `market_id`, so its cardinality grows with every
   * market the oracle ever finalizes. The dashboard queries it through
   * `avg()`/`max()` (`infra/grafana/oracle.json`), which only needs the recent
   * ones, so the collector keeps the most recently finalized markets and drops
   * the tail rather than letting an unbounded label set into Prometheus.
   */
  ORACLE_METRICS_LAG_SERIES: positiveInteger.max(10_000).default(100),
});

export type OracleMetricsConfig = z.infer<typeof schema>;

export function loadOracleMetricsConfig(
  env: NodeJS.ProcessEnv = process.env,
): OracleMetricsConfig {
  return schema.parse(env);
}
