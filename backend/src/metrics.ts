import type { FastifyInstance } from "fastify";
import { serializeCacheMetrics } from "./cache/hitRate.js";

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

// ---------------------------------------------------------------------------
// Status code registry — issue #492
// ---------------------------------------------------------------------------

/**
 * Key: `"<route label>\u0000<statusCode>"`. Value: response count.
 *
 * Cardinality stays bounded by the route table (a fixed, small set of
 * templates) times the small set of HTTP status codes actually returned —
 * never the raw request path, which is what would make this unbounded.
 */
const statusRegistry = new Map<string, number>();

function statusKey(label: string, statusCode: number): string {
  return `${label}\u0000${statusCode}`;
}

// ---------------------------------------------------------------------------
// Abandoned-query counter registry — issue #475
// ---------------------------------------------------------------------------

/**
 * Key: normalised route label, or `"unknown"` when no route was supplied.
 * Value: number of queries cancelled because the client disconnected before
 * the query resolved (see db/pool.ts `queryWithCancel`).
 */
const abandonedQueryRegistry = new Map<string, number>();

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
// Status code counter API — issue #492
// ---------------------------------------------------------------------------

/** Immutable snapshot of a per-route, per-status response count. */
export interface StatusCountSnapshot {
  readonly route: string;
  readonly statusCode: number;
  readonly count: number;
}

/**
 * Record one completed response for a route/status pair.
 *
 * @param method     HTTP method in upper-case, e.g. `"GET"`.
 * @param routePath  Fastify route template, e.g. `"/api/markets/:id"`.
 * @param statusCode HTTP status code of the response.
 */
export function recordStatus(method: string, routePath: string, statusCode: number): void {
  const label = normaliseLabel(method, routePath);
  const key = statusKey(label, statusCode);
  statusRegistry.set(key, (statusRegistry.get(key) ?? 0) + 1);
}

/** Status-code counts for every route/status pair observed, sorted by route then status. */
export function getStatusCounts(): StatusCountSnapshot[] {
  return Array.from(statusRegistry.entries())
    .map(([key, count]) => {
      const [route, statusStr] = key.split("\u0000");
      return Object.freeze({ route: route!, statusCode: Number(statusStr), count });
    })
    .sort((a, b) => a.route.localeCompare(b.route) || a.statusCode - b.statusCode);
}

/** Reset all status-code count data. Useful in tests. */
export function resetStatusCounts(): void {
  statusRegistry.clear();
}

// ---------------------------------------------------------------------------
// Abandoned-query counter API — issue #475
// ---------------------------------------------------------------------------

/**
 * Record one query that was cancelled because its client disconnected
 * before the query resolved. Making this a first-class counter (rather than
 * only a log line) is what lets us confirm the win claimed in #475 is
 * real — i.e. that clients actually disconnect mid-request often enough for
 * cancellation to matter — before investing further here.
 *
 * @param route Fastify route label, e.g. `"GET /api/markets"`. Falls back to
 *              `"unknown"` when the caller doesn't have one handy.
 */
export function recordAbandonedQuery(route?: string): void {
  const label = route ?? "unknown";
  const current = abandonedQueryRegistry.get(label) ?? 0;
  abandonedQueryRegistry.set(label, current + 1);
}

/** Total abandoned-query count for a single route, or `undefined` if none. */
export function getAbandonedQueryCount(route: string): number | undefined {
  return abandonedQueryRegistry.get(route);
}

/** Abandoned-query counts for every route that has recorded at least one. */
export function getAbandonedQueryCounts(): ErrorCountSnapshot[] {
  return Array.from(abandonedQueryRegistry.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => Object.freeze({ route: label, count }));
}

/** Reset all abandoned-query count data. Useful in tests. */
export function resetAbandonedQueryCounts(): void {
  abandonedQueryRegistry.clear();
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

  // Status code breakdown, labelled by route pattern (never the raw path) so
  // cardinality stays bounded by the route table times the status codes
  // actually returned.
  const statusCounts = getStatusCounts();
  if (statusCounts.length > 0) {
    lines.push("# HELP api_requests_total Total number of responses, by route and status code");
    lines.push("# TYPE api_requests_total counter");
    for (const entry of statusCounts) {
      const route = escapeLabelValue(entry.route);
      lines.push(`api_requests_total{route="${route}",status="${entry.statusCode}"} ${entry.count}`);
    }
  }

  // Cache hit rate (issue #214). Always emitted, even before the first
  // lookup — a series that only appears once traffic arrives is a series
  // nobody can build a dashboard panel against.
  return lines.join("\n") + "\n" + serializeCacheMetrics();
}

/**
 * Serialise the database connection-pool gauges (issue #417).
 *
 * The pool module is imported lazily so that loading the metrics serialiser
 * never forces a `DATABASE_URL`/pool to be created in tests or other contexts
 * that never touch the metrics endpoint.
 */
export async function serializePoolMetrics(): Promise<string> {
  const { getPoolMetrics } = await import("./db/pool.js");
  const { total, idle, waiting } = getPoolMetrics();

  return [
    "# HELP db_pool_connections Database connection pool occupancy",
    "# TYPE db_pool_connections gauge",
    `db_pool_connections_total ${total}`,
    `db_pool_connections_idle ${idle}`,
    `db_pool_connections_waiting ${waiting}`,
  ].join("\n");
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
    recordStatus(request.method, routePath, reply.statusCode);

    // Record 5xx server errors for monitoring
    if (reply.statusCode >= 500 && reply.statusCode < 600) {
      recordError(request.method, routePath);
    }
  });
}

/** Header carrying the scrape token that gates the metrics endpoint. */
export const METRICS_TOKEN_HEADER = "x-metrics-token";

/**
 * Checks whether a request is allowed to read `/metrics`.
 *
 * The endpoint carries request-rate and latency data that is operationally
 * sensitive (traffic shape, route inventory), so it must not be reachable by
 * anyone who can reach the API. Without a configured token the endpoint is
 * closed entirely — there is no "open by default" fallback — since a
 * scraper that hasn't been given a token yet is not a reason to leave the
 * route exposed to the public internet in the meantime.
 */
export function isMetricsRequestAuthorized(
  headerValue: string | string[] | undefined,
  expectedToken: string | undefined
): boolean {
  if (!expectedToken) return false;
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return provided === expectedToken;
}

/**
 * Register the /metrics endpoint that serves Prometheus metrics.
 *
 * Gated by a shared-secret token (`METRICS_TOKEN` env var, sent as the
 * `x-metrics-token` header) so the endpoint is not publicly exposed — a
 * missing or mismatched token gets the same 404 as any other unknown route,
 * so the endpoint's existence isn't disclosed either.
 *
 * Call this once inside {@link buildServer} to expose metrics at GET /metrics.
 */
export function registerMetricsEndpoint(
  app: FastifyInstance,
  options: { token?: string } = {}
): void {
  const expectedToken = options.token ?? process.env.METRICS_TOKEN;

  app.get(
    "/metrics",
    {
      schema: {
        summary: "Prometheus metrics endpoint (requires x-metrics-token header)",
        tags: ["system"],
        response: {
          200: {
            type: "string",
            description: "Prometheus text exposition format metrics",
          },
        },
      },
    },
    async (req, reply) => {
      if (!isMetricsRequestAuthorized(req.headers[METRICS_TOKEN_HEADER], expectedToken)) {
        reply.callNotFound();
        return;
      }

      const pool = await serializePoolMetrics();
      reply
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(`${serializeMetrics()}\n${pool}`);
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
