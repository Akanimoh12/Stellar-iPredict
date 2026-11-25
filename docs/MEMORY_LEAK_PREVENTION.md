# Memory Leak Prevention & Heap Diagnostics

The aggregator and indexer are long-running processes. An absolute heap limit
cannot tell a healthy process that has always used 400 MB from one that is
gaining 10 MB every hour, so the services alert on the **trend**, not on a hard
heap ceiling (issue #635).

## How monitoring works

`shared/src/heapMonitor.ts` samples `process.memoryUsage()` every 60 seconds and
keeps a bounded window of 120 samples. It computes a linear growth rate in
bytes/hour over the window and requires:

- at least 5 samples,
- growth above `HEAP_GROWTH_THRESHOLD_BYTES_PER_HOUR` (default 50 MB/hour), and
- at least 60% of intervals showing growth, and
- the trend to hold for 3 consecutive samples.

Only then does it emit an alert hook and set `process_heap_sustained_growth` to
`1`. A GC pause or a one-off startup allocation therefore does not page anyone.
The example and production values are configured in code; operators can change
the sampling cadence and snapshot path with the environment variables below.

## Endpoints

Both services expose the same diagnostics on their metrics port:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/metrics` | Prometheus text, including `process_heap_growth_bytes_per_hour` and `process_heap_sustained_growth` |
| `GET` | `/debug/heap` | Current trend as JSON (sample count, growth/hour, monotonic ratio) |
| `POST` | `/debug/heap-snapshot` | Capture a V8 `.heapsnapshot` file and return its path |

Examples:

```bash
# Indexer (default metrics port 9090)
curl -s localhost:9090/debug/heap
curl -X POST localhost:9090/debug/heap-snapshot

# Oracle aggregator (default port 9102)
curl -X POST localhost:9102/debug/heap-snapshot
```

Snapshots are written to `HEAP_SNAPSHOT_DIR` (default `./heap-snapshots`) and
are rate-limited to one every 5 minutes — a snapshot is hundreds of MB and
serialising it repeatedly would make an incident worse. The endpoint should only
be reachable from the private network; bind the metrics server with
`METRICS_HOST` / `AGGREGATOR_METRICS_HOST` as appropriate.

## Known structures that can grow without bound

These are the places to look first when a trend alert fires. Some are already
bounded in code; they are listed so an on-call engineer does not re-investigate
them from scratch.

| Structure | File | Current mitigation | Risk |
|---|---|---|---|
| Adapter response cache `entries` | `oracle/src/adapters/responseCache.ts` | 5s TTL, in-flight promise dedupe, max 500 keys with expired-key sweep on access | High if provider request shapes are user-controlled; each key holds a response promise |
| Alert router `dedupeMap` / `inFlight` | `oracle/src/aggregator/alert.ts` | `inFlight` is deleted after delivery; `dedupeMap` is capped at 1,000 keys and pruned by age | Medium — keyed by market ID + severity + channel |
| Resolution-lag `entries` | `oracle/src/aggregator/metrics.ts` | Hard cap `MAX_ENTRIES = 50`; aggregates (sum/count/histogram) retained separately | Low |
| Indexer `RpcErrorCounter.values` / `EventCounter.counters` | `indexer/src/metrics.ts` | Bounded by the set of service/operation and event-type labels; never by error text | Medium if a new event type is introduced in a loop |
| Redis invalidation helpers | `indexer/src/cache.ts` | No in-process state — Redis owns expiry | Low |
| Backfill/decoded-event batches | `indexer/src/backfill.ts` | Capped page size and chunked processing | Low |

If a trend alert fires, capture a snapshot **before** restarting the process: a
restart destroys the evidence. Compare two snapshots taken 10–30 minutes apart;
the retaining object graph is the leak, not the largest single object.

## Related alerts

- `SustainedHeapGrowth` — `infra/prometheus/alerts.yml`
- `IndexerBackpressureSustained` — backpressure may present as memory pressure
  while batches queue up (issue #636)
