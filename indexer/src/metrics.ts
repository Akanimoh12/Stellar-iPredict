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
  rpcErrors: new RpcErrorCounter(),
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
}
