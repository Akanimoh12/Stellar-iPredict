import type { FastifyInstance } from "fastify";

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
// Fastify integration
// ---------------------------------------------------------------------------

/**
 * Register an `onResponse` hook that records every completed request into the
 * histogram.
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
  });
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
