/**
 * Lightweight, dependency-free metrics for the backend API.
 *
 * These are simple in-process counters that operational tooling can scrape or
 * log. They intentionally avoid a Prometheus client dependency — the values can
 * be exported to whatever sink the deployment uses.
 */

/** A monotonically increasing counter. */
export class Counter {
  private value = 0;

  /** Increment by `delta` (default 1). Negative deltas are ignored. */
  inc(delta = 1): void {
    if (delta <= 0) return;
    this.value += delta;
  }

  /** Current value. */
  get(): number {
    return this.value;
  }

  /** Reset to zero — primarily for tests. */
  reset(): void {
    this.value = 0;
  }
}

/**
 * Backend API metrics registry.
 *
 * `serverErrors` counts HTTP responses with status codes in the 500–599 range.
 * This metric increments whenever the API returns a server error, regardless
 * of the specific 5xx code (500, 502, 503, etc.).
 */
export const metrics = {
  serverErrors: new Counter(),
};

/** Reset all metrics to zero. Intended for tests. */
export function resetMetrics(): void {
  metrics.serverErrors.reset();
}
