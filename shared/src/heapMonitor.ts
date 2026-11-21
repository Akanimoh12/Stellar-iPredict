/**
 * Trend-based heap monitoring for long-running services — issue #635.
 *
 * An absolute heap threshold cannot tell a healthy process that has always
 * used 400 MB from one that is gaining 10 MB every hour. This monitor samples
 * `process.memoryUsage()`, estimates a growth rate over a bounded window and
 * only alerts when growth is sustained across several samples, so GC pauses
 * and startup transients do not page anyone.
 *
 * The same module exposes the two operational primitives the issue asks for:
 * a Prometheus series for the trend, and an on-demand V8 heap snapshot that
 * services can trigger from their existing metrics server. No third-party
 * dependency is needed — `v8.writeHeapSnapshot` ships with Node.
 */

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";

export interface HeapSample {
  atMs: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
}

export interface HeapGrowthAssessment {
  service: string;
  sampleCount: number;
  /** Heap currently in use, in bytes. Informational — never an alert input. */
  heapUsedBytes: number;
  /** Linear growth across the sampling window, in bytes/hour. */
  growthBytesPerHour: number;
  /** Fraction of intervals in which the heap grew (ignores tiny GC noise). */
  monotonicRatio: number;
  /** True once the trend is fast enough and consistent enough to act on. */
  trending: boolean;
  /** True while the trend has held for `sustainedSamples` consecutive samples. */
  sustained: boolean;
  /** True once per sustained-growth episode, for alert hooks. */
  shouldAlert: boolean;
  sustainedMs: number;
  lastSampleAtMs: number | null;
}

export interface HeapSnapshotResult {
  path: string;
  createdAtMs: number;
  /** Bytes written, when Node reports them. */
  bytes: number | null;
}

export interface HeapMonitorOptions {
  /** Stable service name used as a Prometheus label. */
  service: string;
  /** Sampling period used by `start()`. Default 60s. */
  sampleIntervalMs?: number;
  /** Trend window length. Default 30 min. */
  windowMs?: number;
  /** Fewest samples before a trend is trusted. Default 5. */
  minSamples?: number;
  /** Alert above this growth rate. Default 50 MB/hour. */
  growthThresholdBytesPerHour?: number;
  /** Consecutive trending samples before alerting. Default 3. */
  sustainedSamples?: number;
  /** Hard cap on retained samples — the monitor must not leak itself. Default 120. */
  maxSamples?: number;
  /** Where snapshots are written. Default `HEAP_SNAPSHOT_DIR` or ./heap-snapshots. */
  snapshotDir?: string;
  /** Minimum time between snapshots. Default 5 min. */
  snapshotCooldownMs?: number;
  /** Injected clock for deterministic callers. */
  now?: () => number;
  /** Injected memory reader — defaults to `process.memoryUsage()`. */
  readMemory?: () => { heapUsed: number; heapTotal: number; rss: number };
  /** Called once when sustained growth is first detected. */
  onAlert?: (assessment: HeapGrowthAssessment) => void | Promise<void>;
}

export const DEFAULT_HEAP_SAMPLE_INTERVAL_MS = 60_000;
export const DEFAULT_HEAP_WINDOW_MS = 30 * 60_000;
export const DEFAULT_HEAP_MIN_SAMPLES = 5;
export const DEFAULT_HEAP_GROWTH_THRESHOLD_BYTES_PER_HOUR = 50 * 1024 * 1024;
export const DEFAULT_HEAP_SUSTAINED_SAMPLES = 3;
export const DEFAULT_HEAP_MAX_SAMPLES = 120;
export const DEFAULT_HEAP_SNAPSHOT_COOLDOWN_MS = 5 * 60_000;

/** Ignore sub-kilobyte jitter when deciding whether the heap grew. */
const GROWTH_NOISE_BYTES = 1024;

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

type Trend = Pick<
  HeapGrowthAssessment,
  | "sampleCount"
  | "heapUsedBytes"
  | "growthBytesPerHour"
  | "monotonicRatio"
  | "trending"
  | "lastSampleAtMs"
>;

/**
 * Samples and assesses heap growth. Call {@link sample} from an existing
 * interval (or call {@link start} to own one), then export
 * {@link serializePrometheus} alongside the service's other metrics.
 */
export class HeapMonitor {
  private readonly samples: HeapSample[] = [];
  private readonly service: string;
  private readonly sampleIntervalMs: number;
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly growthThresholdBytesPerHour: number;
  private readonly sustainedSamples: number;
  private readonly maxSamples: number;
  private readonly snapshotDir: string;
  private readonly snapshotCooldownMs: number;
  private readonly now: () => number;
  private readonly readMemory: () => { heapUsed: number; heapTotal: number; rss: number };
  private readonly onAlert?: (assessment: HeapGrowthAssessment) => void | Promise<void>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private sampleCountTotal = 0;
  private consecutiveTrendingSamples = 0;
  private alerted = false;
  private lastSnapshotAtMs: number | null = null;
  private lastAssessment: HeapGrowthAssessment | null = null;

  constructor(options: HeapMonitorOptions) {
    this.service = options.service;
    this.sampleIntervalMs = positiveInt(options.sampleIntervalMs, DEFAULT_HEAP_SAMPLE_INTERVAL_MS);
    this.windowMs = positiveInt(options.windowMs, DEFAULT_HEAP_WINDOW_MS);
    this.minSamples = positiveInt(options.minSamples, DEFAULT_HEAP_MIN_SAMPLES);
    this.growthThresholdBytesPerHour = positiveInt(
      options.growthThresholdBytesPerHour,
      DEFAULT_HEAP_GROWTH_THRESHOLD_BYTES_PER_HOUR,
    );
    this.sustainedSamples = positiveInt(
      options.sustainedSamples,
      DEFAULT_HEAP_SUSTAINED_SAMPLES,
    );
    this.maxSamples = Math.max(
      this.minSamples + 1,
      positiveInt(options.maxSamples, DEFAULT_HEAP_MAX_SAMPLES),
    );
    this.snapshotDir = options.snapshotDir ?? process.env.HEAP_SNAPSHOT_DIR ?? "heap-snapshots";
    this.snapshotCooldownMs = positiveInt(
      options.snapshotCooldownMs,
      DEFAULT_HEAP_SNAPSHOT_COOLDOWN_MS,
    );
    this.now = options.now ?? Date.now;
    this.readMemory = options.readMemory ?? (() => process.memoryUsage());
    this.onAlert = options.onAlert;
  }

  /** Takes one sample, updates the trend and fires an alert hook at episode start. */
  sample(): HeapSample {
    const memory = this.readMemory();
    const sample: HeapSample = {
      atMs: this.now(),
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      rssBytes: memory.rss,
    };
    this.samples.push(sample);
    this.sampleCountTotal += 1;
    // A fixed-size ring: monitoring a leak must not itself leak memory.
    while (this.samples.length > this.maxSamples) this.samples.shift();

    const trend = this.computeTrend();
    if (trend.trending) this.consecutiveTrendingSamples += 1;
    else this.consecutiveTrendingSamples = 0;

    const sustained = trend.trending && this.consecutiveTrendingSamples >= this.sustainedSamples;
    const shouldAlert = sustained && !this.alerted;
    if (shouldAlert) this.alerted = true;
    if (!sustained) this.alerted = false;

    const first = this.samples[0];
    const sustainedMs =
      sustained && first ? sample.atMs - first.atMs : 0;
    this.lastAssessment = { ...trend, sustained, shouldAlert, sustainedMs };
    if (shouldAlert) this.emitAlert(this.lastAssessment);
    return sample;
  }

  /** Current assessment without taking a new sample. */
  assessment(): HeapGrowthAssessment {
    return this.lastAssessment ?? { ...this.computeTrend(), sustained: false, shouldAlert: false, sustainedMs: 0 };
  }

  /** Copy of the bounded sample buffer, oldest first. */
  samplesSnapshot(): readonly HeapSample[] {
    return [...this.samples];
  }

  /** Starts periodic sampling. Safe to call repeatedly. */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
    // A monitoring interval must never keep an otherwise idle process alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Writes a V8 heap snapshot to the configured directory. Returns `null` when
   * the cooldown has not elapsed — snapshots are large and serialising them
   * often would make an incident worse.
   */
  writeSnapshot(label = "manual"): HeapSnapshotResult | null {
    const atMs = this.now();
    if (this.lastSnapshotAtMs !== null && atMs - this.lastSnapshotAtMs < this.snapshotCooldownMs) {
      return null;
    }

    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "manual";
    mkdirSync(this.snapshotDir, { recursive: true });
    const stamp = new Date(atMs).toISOString().replace(/[:.]/g, "-");
    const file = join(this.snapshotDir, `heap-${this.service}-${stamp}-${safeLabel}.heapsnapshot`);
    const path = writeHeapSnapshot(file);
    const size = statSync(path).size;
    this.lastSnapshotAtMs = atMs;
    return { path, createdAtMs: atMs, bytes: size };
  }

  /** Prometheus exposition lines for the trend and the current sample. */
  serializePrometheus(): string[] {
    const a = this.assessment();
    const label = escapeLabel(this.service);
    return [
      "# HELP process_heap_used_bytes Current V8 heap usage; informational, not an alert input.",
      "# TYPE process_heap_used_bytes gauge",
      `process_heap_used_bytes{service="${label}"} ${a.heapUsedBytes}`,
      "# HELP process_heap_total_bytes V8 heap capacity; informational, not an alert input.",
      "# TYPE process_heap_total_bytes gauge",
      `process_heap_total_bytes{service="${label}"} ${this.samples.length > 0 ? this.samples[this.samples.length - 1]!.heapTotalBytes : 0}`,
      "# HELP process_heap_growth_bytes_per_hour Trend of heap usage over the sampling window.",
      "# TYPE process_heap_growth_bytes_per_hour gauge",
      `process_heap_growth_bytes_per_hour{service="${label}"} ${a.growthBytesPerHour}`,
      "# HELP process_heap_sustained_growth 1 while growth is sustained across consecutive samples.",
      "# TYPE process_heap_sustained_growth gauge",
      `process_heap_sustained_growth{service="${label}"} ${a.sustained ? 1 : 0}`,
      "# HELP process_heap_samples_total Number of heap samples taken since process start.",
      "# TYPE process_heap_samples_total counter",
      `process_heap_samples_total{service="${label}"} ${this.sampleCountTotal}`,
      "# HELP process_heap_last_snapshot_timestamp_seconds Time of the last captured heap snapshot, or 0.",
      "# TYPE process_heap_last_snapshot_timestamp_seconds gauge",
      `process_heap_last_snapshot_timestamp_seconds{service="${label}"} ${this.lastSnapshotAtMs === null ? 0 : this.lastSnapshotAtMs / 1000}`,
    ];
  }

  private computeTrend(): Trend {
    const count = this.samples.length;
    const last = count > 0 ? this.samples[count - 1] : undefined;
    const first = count > 0 ? this.samples[0] : undefined;
    if (!last || !first) {
      return {
        service: this.service,
        sampleCount: 0,
        heapUsedBytes: 0,
        growthBytesPerHour: 0,
        monotonicRatio: 0,
        trending: false,
        lastSampleAtMs: null,
      };
    }

    const elapsedMs = last.atMs - first.atMs;
    const growthBytes = last.heapUsedBytes - first.heapUsedBytes;
    const growthBytesPerHour =
      elapsedMs > 0 ? (growthBytes / elapsedMs) * 60 * 60 * 1000 : 0;

    let increases = 0;
    let intervals = 0;
    for (let i = 1; i < count; i++) {
      const previous = this.samples[i - 1];
      const current = this.samples[i];
      intervals += 1;
      if (current.heapUsedBytes > previous.heapUsedBytes + GROWTH_NOISE_BYTES) increases += 1;
    }
    const monotonicRatio = intervals > 0 ? increases / intervals : 0;

    // Startup fills the buffer over time; until then the "rate" would be
    // computed from too few points and would react to a single GC cycle.
    const enoughData =
      count >= this.minSamples && elapsedMs >= ((this.minSamples - 1) * this.sampleIntervalMs) / 2;
    const trending =
      enoughData && growthBytesPerHour >= this.growthThresholdBytesPerHour && monotonicRatio >= 0.6;

    return {
      service: this.service,
      sampleCount: count,
      heapUsedBytes: last.heapUsedBytes,
      growthBytesPerHour,
      monotonicRatio,
      trending,
      lastSampleAtMs: last.atMs,
    };
  }

  private emitAlert(assessment: HeapGrowthAssessment): void {
    if (!this.onAlert) return;
    void Promise.resolve()
      .then(() => this.onAlert?.(assessment))
      .catch(() => undefined);
  }
}

/** Convenience constructor with the standard service defaults. */
export function createHeapMonitor(options: HeapMonitorOptions): HeapMonitor {
  return new HeapMonitor(options);
}
