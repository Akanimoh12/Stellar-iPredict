/**
 * Lightweight, dependency-free metrics for the indexer.
 *
 * These are simple in-process counters that operational tooling can scrape or
 * log. They intentionally avoid a Prometheus client dependency — the values can
 * be exported to whatever sink the deployment uses (see the runbook in
 * `README.md` and the metric catalogue in `docs/ORACLE_AND_BACKEND.md`).
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

/** A gauge that can be set to any value (can go up or down). */
export class Gauge {
  private value = 0;

  /** Set to a specific value. */
  set(value: number): void {
    this.value = value;
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
 * Indexer metrics registry.
 *
 * `eventsProcessed` corresponds to the `events_processed_total` counter
 * documented in `docs/ORACLE_AND_BACKEND.md`; it is incremented once per
 * contract event the indexer successfully handles.
 *
 * `indexerLag` corresponds to the `indexer_lag_ledgers` gauge documented in
 * `docs/ORACLE_AND_BACKEND.md`; it represents the difference between the
 * latest ledger from the RPC and the indexer's checkpoint ledger.
 */
export const metrics = {
  eventsProcessed: new Counter(),
  indexerLag: new Gauge(),
};

/** Reset all metrics to zero. Intended for tests. */
export function resetMetrics(): void {
  metrics.eventsProcessed.reset();
  metrics.indexerLag.reset();
}
