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

export interface RpcErrorLabels {
  /** Process making the RPC call (for example `indexer` or `oracle`). */
  service: string;
  /** Stable RPC method name. Never use URLs or error messages here. */
  operation: string;
}

export interface RpcErrorSnapshot extends RpcErrorLabels {
  count: number;
}

/**
 * A labelled counter for failed RPC calls.
 *
 * Labels are deliberately restricted to service and operation to keep
 * Prometheus cardinality bounded. Error messages, URLs, transaction hashes,
 * and market IDs must not be used as labels.
 */
export class RpcErrorCounter {
  private readonly values = new Map<string, RpcErrorSnapshot>();

  inc(labels: RpcErrorLabels, delta = 1): void {
    if (delta <= 0) return;
    const service = labels.service.trim();
    const operation = labels.operation.trim();
    if (!service || !operation) {
      throw new TypeError("rpc error labels must not be empty");
    }

    const key = `${service}\u0000${operation}`;
    const current = this.values.get(key);
    this.values.set(key, {
      service,
      operation,
      count: (current?.count ?? 0) + delta,
    });
  }

  get(labels: RpcErrorLabels): number {
    return this.values.get(`${labels.service.trim()}\u0000${labels.operation.trim()}`)?.count ?? 0;
  }

  snapshot(): RpcErrorSnapshot[] {
    return [...this.values.values()]
      .sort((a, b) => a.service.localeCompare(b.service) || a.operation.localeCompare(b.operation))
      .map((entry) => Object.freeze({ ...entry }));
  }

  reset(): void {
    this.values.clear();
  }
}

/** Histogram bucket for tracking poll iteration duration. */
export class Histogram {
  private buckets: Map<number, number> = new Map();
  private sum = 0;
  private count = 0;
  private readonly bucketBoundaries: number[];

  constructor(bucketBoundaries: number[] = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60]) {
    this.bucketBoundaries = [...bucketBoundaries].sort((a, b) => a - b);
    this.bucketBoundaries.forEach((boundary) => this.buckets.set(boundary, 0));
  }

  observe(value: number): void {
    if (value < 0) return;
    this.sum += value;
    this.count += 1;

    for (const boundary of this.bucketBoundaries) {
      if (value <= boundary) {
        this.buckets.set(boundary, (this.buckets.get(boundary) || 0) + 1);
      }
    }
  }

  snapshot(): { buckets: Map<number, number>; sum: number; count: number } {
    return {
      buckets: new Map(this.buckets),
      sum: this.sum,
      count: this.count,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.bucketBoundaries.forEach((boundary) => this.buckets.set(boundary, 0));
    this.sum = 0;
    this.count = 0;
  }
}

/** Labelled counter for tracking events by type. */
export class EventCounter {
  private readonly counters = new Map<string, number>();

  inc(eventType: string, delta = 1): void {
    if (delta <= 0) return;
    const sanitized = eventType.trim() || "unknown";
    this.counters.set(sanitized, (this.counters.get(sanitized) || 0) + delta);
  }

  get(eventType: string): number {
    return this.counters.get(eventType.trim()) || 0;
  }

  snapshot(): Map<string, number> {
    return new Map(this.counters);
  }

  reset(): void {
    this.counters.clear();
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
 *
 * `eventsByType`: Counter for events processed, broken down by event type.
 * `eventsDeadLettered`: Counter for events that failed processing.
 * `pollDuration`: Histogram tracking poll iteration duration in seconds.
 */
export const metrics = {
  eventsProcessed: new Counter(),
  indexerLag: new Gauge(),
  rpcErrors: new RpcErrorCounter(),
  eventsByType: new EventCounter(),
  eventsDeadLettered: new Counter(),
  pollDuration: new Histogram([0.1, 0.5, 1, 2.5, 5, 10, 30, 60]),
};

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Serialize the RPC counter in Prometheus text exposition format. */
export function serializeRpcErrors(): string {
  const header = [
    "# HELP rpc_errors_total Total number of failed RPC calls.",
    "# TYPE rpc_errors_total counter",
  ];
  const samples = metrics.rpcErrors.snapshot().map(
    ({ service, operation, count }) =>
      `rpc_errors_total{service="${escapeLabel(service)}",operation="${escapeLabel(operation)}"} ${count}`,
  );
  return [...header, ...samples, ""].join("\n");
}

/**
 * Serialize all indexer metrics in Prometheus text exposition format.
 *
 * Exports:
 * - indexer_lag_ledgers: gauge of how far behind the indexer is
 * - events_processed_total: counter of successfully processed events
 * - events_by_type_total: counter of events by type
 * - events_dead_lettered_total: counter of failed events
 * - poll_duration_seconds: histogram of poll iteration duration
 * - rpc_errors_total: counter of failed RPC calls (by service + operation)
 */
export function serializeMetrics(): string {
  const lines: string[] = [];

  // Indexer lag gauge
  lines.push("# HELP indexer_lag_ledgers The difference between the latest ledger and the indexer checkpoint");
  lines.push("# TYPE indexer_lag_ledgers gauge");
  lines.push(`indexer_lag_ledgers ${metrics.indexerLag.get()}`);

  // Events processed counter
  lines.push("# HELP events_processed_total Total number of contract events successfully processed");
  lines.push("# TYPE events_processed_total counter");
  lines.push(`events_processed_total ${metrics.eventsProcessed.get()}`);

  // Events by type counter
  const eventsByType = metrics.eventsByType.snapshot();
  if (eventsByType.size > 0) {
    lines.push("# HELP events_by_type_total Total number of events processed, broken down by event type");
    lines.push("# TYPE events_by_type_total counter");
    for (const [eventType, count] of eventsByType) {
      lines.push(`events_by_type_total{event_type="${escapeLabel(eventType)}"} ${count}`);
    }
  }

  // Dead lettered events counter
  lines.push("# HELP events_dead_lettered_total Total number of events that failed processing");
  lines.push("# TYPE events_dead_lettered_total counter");
  lines.push(`events_dead_lettered_total ${metrics.eventsDeadLettered.get()}`);

  // Poll duration histogram
  const pollHist = metrics.pollDuration.snapshot();
  lines.push("# HELP poll_duration_seconds Time spent in each poll iteration");
  lines.push("# TYPE poll_duration_seconds histogram");
  for (const [le, count] of pollHist.buckets) {
    lines.push(`poll_duration_seconds_bucket{le="${le}"} ${count}`);
  }
  lines.push(`poll_duration_seconds_bucket{le="+Inf"} ${pollHist.count}`);
  lines.push(`poll_duration_seconds_sum ${pollHist.sum}`);
  lines.push(`poll_duration_seconds_count ${pollHist.count}`);

  // RPC errors counter
  const rpcSnapshots = metrics.rpcErrors.snapshot();
  if (rpcSnapshots.length > 0) {
    lines.push("# HELP rpc_errors_total Total number of failed RPC calls");
    lines.push("# TYPE rpc_errors_total counter");
    for (const { service, operation, count } of rpcSnapshots) {
      lines.push(
        `rpc_errors_total{service="${escapeLabel(service)}",operation="${escapeLabel(operation)}"} ${count}`
      );
    }
  }

  return lines.join("\n") + "\n";
}

/** Reset all metrics to zero. Intended for tests. */
export function resetMetrics(): void {
  metrics.eventsProcessed.reset();
  metrics.indexerLag.reset();
  metrics.rpcErrors.reset();
  metrics.eventsByType.reset();
  metrics.eventsDeadLettered.reset();
  metrics.pollDuration.reset();
}
