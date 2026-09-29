/**
 * Prometheus text exposition (version 0.0.4) for the oracle — issue #211.
 *
 * Metric names come from the catalogue in
 * `docs/ORACLE_AND_BACKEND.md#monitoring` and are the ones the Grafana oracle
 * dashboard already queries (`infra/grafana/oracle.json`):
 *
 * | Metric | Type | Dashboard query |
 * |---|---|---|
 * | `oracle_submissions_total` | counter | `sum(rate(oracle_submissions_total[…]))` |
 * | `oracle_disputes_total` | counter | `sum(rate(oracle_disputes_total[…]))` |
 * | `oracle_resolution_lag_h{market_id}` | gauge | `avg(…)` and `max(…)` |
 *
 * Three endpoint-health metrics are added alongside them. Without those, a
 * collector that has been failing for an hour is indistinguishable from an
 * oracle with no new activity — both serve the same numbers.
 *
 * Written by hand rather than with `prom-client` to match
 * `backend/src/metrics.ts` and `indexer/src/metrics.ts`: the backend stack
 * carries no metrics dependency, and the exposition format is a dozen lines.
 */

import type { OracleMetricsSnapshot } from "./collector.js";

/** Escape a label value per the exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * Format a number the way Prometheus expects.
 *
 * `NaN`/`Infinity` are legal in the text format but only spelled that way;
 * JavaScript's `String(Infinity)` produces `"Infinity"`, which a scraper
 * rejects.
 */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

/**
 * Render a snapshot as a Prometheus scrape body.
 *
 * @param snapshot Latest collector output.
 * @param up       Whether the oracle's dependencies are reachable. Exposed as
 *                 `oracle_up`, so an alert can distinguish "the oracle is
 *                 down" from "Prometheus cannot reach the target at all",
 *                 which the built-in `up` metric conflates with a dead host.
 */
export function serializeOracleMetrics(
  snapshot: OracleMetricsSnapshot,
  up: boolean = true,
): string {
  const lines: string[] = [];

  lines.push("# HELP oracle_submissions_total Total oracle submissions recorded in Postgres");
  lines.push("# TYPE oracle_submissions_total counter");
  lines.push(`oracle_submissions_total ${formatValue(snapshot.submissionsTotal)}`);

  lines.push("# HELP oracle_disputes_total Total challenged oracle submissions recorded in Postgres");
  lines.push("# TYPE oracle_disputes_total counter");
  lines.push(`oracle_disputes_total ${formatValue(snapshot.disputesTotal)}`);

  // The HELP/TYPE pair is emitted even with no samples so the series is
  // discoverable in Prometheus before the first market resolves.
  lines.push("# HELP oracle_resolution_lag_h Hours between market expiry and oracle finalization");
  lines.push("# TYPE oracle_resolution_lag_h gauge");
  for (const sample of snapshot.resolutionLag) {
    lines.push(
      `oracle_resolution_lag_h{market_id="${escapeLabelValue(sample.marketId)}"} ${formatValue(sample.lagHours)}`,
    );
  }

  lines.push("# HELP oracle_up Whether the oracle metrics collector reached its dependencies");
  lines.push("# TYPE oracle_up gauge");
  lines.push(`oracle_up ${up ? 1 : 0}`);

  lines.push(
    "# HELP oracle_metrics_last_refresh_timestamp_seconds Unix time of the last successful metrics refresh",
  );
  lines.push("# TYPE oracle_metrics_last_refresh_timestamp_seconds gauge");
  lines.push(
    `oracle_metrics_last_refresh_timestamp_seconds ${formatValue(snapshot.lastRefreshUnixSeconds ?? 0)}`,
  );

  lines.push(
    "# HELP oracle_metrics_collection_errors_total Metrics refreshes that failed since start",
  );
  lines.push("# TYPE oracle_metrics_collection_errors_total counter");
  lines.push(`oracle_metrics_collection_errors_total ${formatValue(snapshot.collectionErrors)}`);

  return lines.join("\n") + "\n";
}
