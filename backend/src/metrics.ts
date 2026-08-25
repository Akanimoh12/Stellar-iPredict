import type { FastifyInstance } from "fastify";
import { serviceUnavailable } from "./lib/errors.js";

/**
 * Request-duration histogram — issue #87
 *
 * Records per-route latency in a fixed set of exponential buckets (ms).
 * Each observation is stored as a counter in `counts` for the matching bucket
 * and the exact duration is accumulated in `sum`, allowing downstream systems
 * to derive:
 *
 *   - percentile approximations  (p50, p95, p99) from the bucket counts
 *   - arithmetic mean            (sum / count)
 *
 * ### Design choices
 *
 * No external dependencies (no prom-client) — the histogram is pure
 * in-process state so the backend stays zero-dependency at the metrics layer.
 * A `/api/metrics` endpoint (or a Prometheus scrape plugin) can consume
 * `getHistogram()` / `getSnapshot()` and serialise however it likes.
 *
 * Thread safety: Node.js is single-threaded; no locking is required.
 */

/**
 * Error-rate counter — issue #86
 *
 * Counts 5xx server error responses for monitoring.
 * Provides a simple counter that can be used to track API error rates
 * and alert on elevated error levels.
 */

// ---------------------------------------------------------------------------
// Bucket boundaries (milliseconds, upper-inclusive)
// ---------------------------------------------------------------------------

/**
 * Default exponential bucket boundaries in milliseconds.
 *
 * Covers the range from sub-millisecond responses all the way to very slow
 * requests (10 s), with +Infinity as the catch-all overflow bucket.
 */
export const DEFAULT_BUCKETS: readonly number[] = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, Infinity,
]);

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Immutable snapshot of a single route histogram — safe to serialise. */
export interface HistogramSnapshot {
  /** Fully normalised route label, e.g. `"GET /api/markets"`. */
  readonly route: string;
  /** Upper-inclusive bucket boundaries (ms). Last entry is always `Infinity`. */
  readonly buckets: readonly number[];
  /**
   * Cumulative observation count per bucket.
   * `counts[i]` is the number of requests whose duration was ≤ `buckets[i]`
   * AND > `buckets[i-1]` (i.e. non-overlapping, not prometheus-style
   * cumulative). Use {@link cumulativeCounts} when you need cumulative form.
   */
  readonly counts: readonly number[];
  /** Sum of all observed durations (ms). */
  readonly sum: number;
  /** Total number of observations. */
  readonly count: number;
}

/** Immutable snapshot of error counts — safe to serialise. */
export interface ErrorCountSnapshot {
  /** Fully normalised route label, e.g. `"GET /api/markets"`. */
  readonly route: string;
  /** Total number of 5xx responses for this route. */
  readonly count: number;
}

export interface BusinessMetricsSnapshot {
  readonly marketsCreatedTotal: number;
  readonly betsPlacedTotal: number;
  readonly volumeXlmTotal: string;
  readonly marketsResolvedTotal: number;
}

interface MetricsQueryable {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Internal mutable state for a single route.
 * Not exposed externally — callers always get a frozen snapshot.
 */
interface HistogramEntry {
  buckets: readonly number[];
  counts: number[];
  sum: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Histogram registry
// ---------------------------------------------------------------------------

/** Key: normalised route label (`"METHOD /path"`). */
const registry = new Map<string, HistogramEntry>();

/** Bucket configuration used for new entries. Settable once at startup. */
let activeBuckets: readonly number[] = DEFAULT_BUCKETS;

// ---------------------------------------------------------------------------
// Error counter registry
// ---------------------------------------------------------------------------

/** Key: normalised route label (`"METHOD /path"`). Value: 5xx response count. */
const errorRegistry = new Map<string, number>();

interface BusinessMetricsRow {
  markets_created_total: string | number;
  bets_placed_total: string | number;
  volume_xlm_total: string | number;
  markets_resolved_total: string | number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Override the bucket boundaries used for **new** histogram entries.
 *
 * Must be called before the first observation, typically at server startup.
 * Already-created entries keep their original buckets.
 *
 * @param buckets Sorted ascending list of upper-inclusive boundaries (ms).
 *                The last value **must** be `Infinity`.
 * @throws {RangeError} if `buckets` is empty, not sorted, or lacks `Infinity`.
 */
export function configureBuckets(buckets: readonly number[]): void {
  if (buckets.length === 0) {
    throw new RangeError("buckets must not be empty");
  }
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]! <= buckets[i - 1]!) {
      throw new RangeError("buckets must be strictly ascending");
    }
  }
  if (buckets[buckets.length - 1] !== Infinity) {
    throw new RangeError("last bucket must be Infinity");
  }
  activeBuckets = Object.freeze([...buckets]);
}

/**
 * Record one request observation.
 *
 * @param method      HTTP method in upper-case, e.g. `"GET"`.
 * @param routePath   Fastify route path (with parameter names, not values),
 *                    e.g. `"/api/markets/:id"`.
 * @param durationMs  Elapsed time in milliseconds (floating-point OK).
 */
export function observe(
  method: string,
  routePath: string,
  durationMs: number
): void {
  const label = normaliseLabel(method, routePath);

  let entry = registry.get(label);
  if (!entry) {
    entry = {
      buckets: activeBuckets,
      counts: new Array<number>(activeBuckets.length).fill(0),
      sum: 0,
      count: 0,
    };
    registry.set(label, entry);
  }

  // Find the first bucket whose upper bound ≥ durationMs.
  const idx = entry.buckets.findIndex((b) => durationMs <= b);
  // idx === -1 can only happen if Infinity is missing (guarded by
  // configureBuckets / DEFAULT_BUCKETS), but clamp defensively.
  const bucketIdx = idx === -1 ? entry.counts.length - 1 : idx;
  entry.counts[bucketIdx]!++;
  entry.sum += durationMs;
  entry.count++;
}

/**
 * Return an immutable snapshot of the histogram for a single route, or
 * `undefined` if no observation has been recorded for that route yet.
 *
 * @param method    HTTP method in upper-case.
 * @param routePath Fastify route path (template, not the actual URL).
 */
export function getSnapshot(
  method: string,
  routePath: string
): HistogramSnapshot | undefined {
  const label = normaliseLabel(method, routePath);
  return snapshotEntry(label, registry.get(label));
}

/**
 * Return immutable snapshots for **all** routes that have received at least
 * one request, sorted alphabetically by route label.
 */
export function getHistogram(): HistogramSnapshot[] {
  return Array.from(registry.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, entry]) => snapshotEntry(label, entry)!);
}

/**
 * Reset all histogram data.
 *
 * Useful in tests and for rolling-window metric resets.
 */
export function resetHistogram(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Error counter API
// ---------------------------------------------------------------------------

/**
 * Record a 5xx server error response.
 *
 * @param method    HTTP method in upper-case, e.g. `"GET"`.
 * @param routePath Fastify route path (with parameter names, not values),
 *                  e.g. `"/api/markets/:id"`.
 */
export function recordError(method: string, routePath: string): void {
  const label = normaliseLabel(method, routePath);
  const current = errorRegistry.get(label) ?? 0;
  errorRegistry.set(label, current + 1);
}

/**
 * Return the error count for a single route, or `undefined` if no errors
 * have been recorded for that route yet.
 *
 * @param method    HTTP method in upper-case.
 * @param routePath Fastify route path (template, not the actual URL).
 */
export function getErrorCount(
  method: string,
  routePath: string
): number | undefined {
  const label = normaliseLabel(method, routePath);
  return errorRegistry.get(label);
}

/**
 * Return error counts for **all** routes that have recorded at least one error,
 * sorted alphabetically by route label.
 */
export function getErrorCounts(): ErrorCountSnapshot[] {
  return Array.from(errorRegistry.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) =>
      Object.freeze({
        route: label,
        count,
      })
    );
}

/**
 * Reset all error count data.
 *
 * Useful in tests and for rolling-window metric resets.
 */
export function resetErrorCounts(): void {
  errorRegistry.clear();
}

// ---------------------------------------------------------------------------
// Business counter API
// ---------------------------------------------------------------------------

export async function getBusinessMetrics(
  db: MetricsQueryable
): Promise<BusinessMetricsSnapshot> {
  const result = await db.query<BusinessMetricsRow>(`
    WITH event_totals AS (
      SELECT
        COUNT(*) FILTER (WHERE event_type IN ('bet_placed', 'bet'))::bigint AS bet_events_total,
        COALESCE(
          SUM(
            CASE
              WHEN event_type IN ('bet_placed', 'bet') THEN COALESCE(
                NULLIF(payload->>'gross_amount', '')::numeric,
                NULLIF(payload->>'gross', '')::numeric,
                NULLIF(payload->>'net_amount', '')::numeric,
                NULLIF(payload->>'amount', '')::numeric,
                NULLIF(payload->>'net', '')::numeric,
                0
              )
              ELSE 0
            END
          ),
          0
        )::text AS bet_volume_total
      FROM events
    ),
    table_totals AS (
      SELECT
        COUNT(*)::bigint AS market_rows_total,
        COUNT(*) FILTER (WHERE resolved = TRUE)::bigint AS resolved_market_rows_total
      FROM markets
    ),
    bet_rows AS (
      SELECT
        COUNT(*)::bigint AS bet_rows_total,
        COALESCE(SUM(gross_amount), 0)::text AS gross_volume_total
      FROM bets
    )
    SELECT
      table_totals.market_rows_total AS markets_created_total,
      CASE
        WHEN event_totals.bet_events_total > 0
          THEN event_totals.bet_events_total
        ELSE bet_rows.bet_rows_total
      END AS bets_placed_total,
      CASE
        WHEN event_totals.bet_events_total > 0
          THEN event_totals.bet_volume_total
        ELSE bet_rows.gross_volume_total
      END AS volume_xlm_total,
      table_totals.resolved_market_rows_total AS markets_resolved_total
    FROM event_totals, table_totals, bet_rows
  `);

  const row = result.rows[0];
  return Object.freeze({
    marketsCreatedTotal: Number(row?.markets_created_total ?? 0),
    betsPlacedTotal: Number(row?.bets_placed_total ?? 0),
    volumeXlmTotal: String(row?.volume_xlm_total ?? "0"),
    marketsResolvedTotal: Number(row?.markets_resolved_total ?? 0),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise method + path into the canonical label stored in the registry. */
export function normaliseLabel(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

/**
 * Convert per-bucket counts to Prometheus-style cumulative counts,
 * where `cumulative[i]` = total observations with duration ≤ `buckets[i]`.
 */
export function cumulativeCounts(counts: readonly number[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const c of counts) {
    running += c;
    out.push(running);
  }
  return out;
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

export function serializeHistogram(): string {
  const header = [
    "# HELP api_request_duration_ms API request duration in milliseconds.",
    "# TYPE api_request_duration_ms histogram",
  ];

  const lines = getHistogram().flatMap((snapshot) => {
    const cumulative = cumulativeCounts(snapshot.counts);
    const route = escapeLabel(snapshot.route);
    const buckets = snapshot.buckets.map((bucket, index) => {
      const le = bucket === Infinity ? "+Inf" : String(bucket);
      return `api_request_duration_ms_bucket{route="${route}",le="${le}"} ${cumulative[index]}`;
    });

    return [
      ...buckets,
      `api_request_duration_ms_sum{route="${route}"} ${snapshot.sum}`,
      `api_request_duration_ms_count{route="${route}"} ${snapshot.count}`,
    ];
  });

  return [...header, ...lines, ""].join("\n");
}

export function serializeErrorCounts(): string {
  const header = [
    "# HELP api_errors_total Total number of 5xx API responses.",
    "# TYPE api_errors_total counter",
  ];

  const lines = getErrorCounts().map(
    ({ route, count }) =>
      `api_errors_total{route="${escapeLabel(route)}"} ${count}`
  );

  return [...header, ...lines, ""].join("\n");
}

export function serializeBusinessMetrics(
  snapshot: BusinessMetricsSnapshot
): string {
  return [
    "# HELP markets_created_total Total number of indexed markets created.",
    "# TYPE markets_created_total counter",
    `markets_created_total ${snapshot.marketsCreatedTotal}`,
    "# HELP bets_placed_total Total number of indexed bets placed.",
    "# TYPE bets_placed_total counter",
    `bets_placed_total ${snapshot.betsPlacedTotal}`,
    "# HELP volume_xlm_total Total indexed platform betting volume in XLM.",
    "# TYPE volume_xlm_total counter",
    `volume_xlm_total ${snapshot.volumeXlmTotal}`,
    "# HELP markets_resolved_total Total number of indexed markets resolved.",
    "# TYPE markets_resolved_total counter",
    `markets_resolved_total ${snapshot.marketsResolvedTotal}`,
    "",
  ].join("\n");
}

export async function serializePrometheusMetrics(
  db: MetricsQueryable
): Promise<string> {
  const businessMetrics = await getBusinessMetrics(db);
  return [
    serializeHistogram().trimEnd(),
    serializeErrorCounts().trimEnd(),
    serializeBusinessMetrics(businessMetrics).trimEnd(),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Prometheus text exposition format serialization
// ---------------------------------------------------------------------------

/** Escape label values for Prometheus text exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * Serialize request duration histogram in Prometheus text exposition format.
 *
 * Produces a histogram with cumulative bucket counts, matching the format
 * expected by Prometheus scrapers. Each route gets three metric lines:
 * - `api_request_duration_ms_bucket{route, le}` — cumulative count ≤ le
 * - `api_request_duration_ms_sum{route}` — total duration sum
 * - `api_request_duration_ms_count{route}` — total observation count
 *
 * Bucket boundaries are in milliseconds.
 */
export function serializeMetrics(): string {
  const histograms = getHistogram();
  const errors = getErrorCounts();

  const lines: string[] = [
    "# HELP api_request_duration_ms_seconds Request latency histogram in milliseconds",
    "# TYPE api_request_duration_ms_seconds histogram",
  ];

  // Emit histogram metrics for each route
  for (const snapshot of histograms) {
    const route = escapeLabelValue(snapshot.route);
    const cumulative = cumulativeCounts(snapshot.counts);

    // Emit bucket observations
    for (let i = 0; i < snapshot.buckets.length; i++) {
      const le = snapshot.buckets[i];
      const leStr = le === Infinity ? "+Inf" : String(le);
      lines.push(
        `api_request_duration_ms_bucket{route="${route}",le="${leStr}"} ${cumulative[i]}`
      );
    }

    // Emit sum and count
    lines.push(`api_request_duration_ms_sum{route="${route}"} ${snapshot.sum}`);
    lines.push(
      `api_request_duration_ms_count{route="${route}"} ${snapshot.count}`
    );
  }

  // Error counter metrics
  if (errors.length > 0) {
    lines.push("# HELP api_errors_total Total number of 5xx server errors");
    lines.push("# TYPE api_errors_total counter");
    for (const error of errors) {
      const route = escapeLabelValue(error.route);
      lines.push(`api_errors_total{route="${route}"} ${error.count}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Fastify integration
// ---------------------------------------------------------------------------

/**
 * Register an `onResponse` hook that records every completed request into the
 * histogram and counts 5xx server errors.
 *
 * Route template (e.g. `/api/markets/:id`) is used as the label rather than
 * the raw URL so wildcard and parameterised routes are grouped correctly.
 * Unknown routes (404s handled before a route is matched) fall back to the
 * raw URL to avoid an unbounded label cardinality problem.
 *
 * Call this once inside {@link buildServer} after other plugins are registered.
 */
export function registerMetricsHook(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    // `request.routeOptions.url` is the route template in Fastify v5.
    // Fall back to the raw URL for unmatched routes (404 / 405).
    const routePath: string =
      (request.routeOptions as { url?: string }).url ?? request.url;
    observe(request.method, routePath, reply.elapsedTime);

    // Record 5xx server errors for monitoring
    if (reply.statusCode >= 500 && reply.statusCode < 600) {
      recordError(request.method, routePath);
    }
  });
}

/**
 * Register the /metrics endpoint that serves Prometheus metrics.
 *
 * Call this once inside {@link buildServer} to expose metrics at GET /metrics.
 */
export function registerMetricsEndpoint(app: FastifyInstance): void {
  app.get(
    "/metrics",
    {
      schema: {
        summary: "Prometheus metrics endpoint",
        tags: ["system"],
        response: {
          200: {
            type: "string",
            description: "Prometheus text exposition format metrics",
          },
        },
      },
    },
    async (_req, reply) => {
      reply.type("text/plain; version=0.0.4; charset=utf-8").send(serializeMetrics());
    }
  );
}

function snapshotEntry(
  label: string,
  entry: HistogramEntry | undefined
): HistogramSnapshot | undefined {
  if (!entry) return undefined;
  return Object.freeze({
    route: label,
    buckets: entry.buckets,
    counts: Object.freeze([...entry.counts]),
    sum: entry.sum,
    count: entry.count,
  });
}
