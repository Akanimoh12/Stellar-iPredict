import type { AdapterHealth, DataAdapter } from "./index.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./httpRetry.js";

export interface HealthScoreEntry {
  timestamp: number;
  available: boolean;
  latencyMs: number;
  error?: string;
  score: number; // 1 for success, 0 for failure
}

export interface AdapterHealthTrend {
  adapterId: string;
  totalChecks: number;
  successfulChecks: number;
  failedChecks: number;
  availabilityRate: number; // 0.0 to 1.0 (successes / total)
  averageLatencyMs: number;
  healthScore: number; // 0.0 to 1.0
  trend: "healthy" | "degrading" | "failing";
  history: readonly HealthScoreEntry[];
}

export interface AdapterHealthReport extends AdapterHealth {
  adapterId: string;
  cached: boolean;
  healthScore?: number;
  trend?: AdapterHealthTrend["trend"];
}

export interface AdapterHealthCheckOptions {
  /** Avoid repeatedly consuming provider quota. Defaults to 60 seconds. */
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** Maximum number of historical records to keep in memory. Defaults to 50. */
  historyWindowSize?: number;
}

const DEFAULT_HISTORY_WINDOW = 50;
const adapterHealthHistories = new Map<string, HealthScoreEntry[]>();

export function recordAdapterHealthEntry(
  adapterId: string,
  health: AdapterHealth,
  windowSize = DEFAULT_HISTORY_WINDOW,
): HealthScoreEntry {
  const entry: HealthScoreEntry = {
    timestamp: Date.now(),
    available: health.available,
    latencyMs: health.latencyMs,
    error: health.error,
    score: health.available ? 1 : 0,
  };
  let list = adapterHealthHistories.get(adapterId);
  if (!list) {
    list = [];
    adapterHealthHistories.set(adapterId, list);
  }
  list.push(entry);
  if (list.length > windowSize) {
    list.splice(0, list.length - windowSize);
  }
  return entry;
}

export function getAdapterHealthHistory(adapterId: string): readonly HealthScoreEntry[] {
  return adapterHealthHistories.get(adapterId) ?? [];
}

export function getAdapterHealthTrend(adapterId: string): AdapterHealthTrend {
  const history = getAdapterHealthHistory(adapterId);
  const total = history.length;
  if (total === 0) {
    return {
      adapterId,
      totalChecks: 0,
      successfulChecks: 0,
      failedChecks: 0,
      availabilityRate: 1.0,
      averageLatencyMs: 0,
      healthScore: 1.0,
      trend: "healthy",
      history: [],
    };
  }

  const successful = history.filter((e) => e.available).length;
  const failed = total - successful;
  const availabilityRate = successful / total;
  const totalLatency = history.reduce((sum, e) => sum + e.latencyMs, 0);
  const averageLatencyMs = totalLatency / total;

  // Recent trend: evaluate the last 5 checks if available
  const recent = history.slice(-5);
  const recentSuccess = recent.filter((e) => e.available).length;
  const recentRate = recentSuccess / recent.length;

  let trend: "healthy" | "degrading" | "failing" = "healthy";
  if (recentRate === 0) {
    trend = "failing";
  } else if (recentRate < 0.8 || availabilityRate < 0.8) {
    trend = "degrading";
  }

  return {
    adapterId,
    totalChecks: total,
    successfulChecks: successful,
    failedChecks: failed,
    availabilityRate,
    averageLatencyMs,
    healthScore: availabilityRate,
    trend,
    history,
  };
}

export function clearAdapterHealthHistory(adapterId?: string): void {
  if (adapterId) {
    adapterHealthHistories.delete(adapterId);
  } else {
    adapterHealthHistories.clear();
  }
}

const cache = new Map<string, { expiresAt: number; report: AdapterHealthReport }>();

export async function probeHttp(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions,
): Promise<AdapterHealth> {
  const startedAt = Date.now();
  await fetchWithRetry(url, init, { ...options, maxRetries: 1 });
  return { available: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
}

export async function checkAdapterHealth(
  adapter: DataAdapter,
  options: AdapterHealthCheckOptions = {},
): Promise<AdapterHealthReport> {
  const now = Date.now();
  const cached = cache.get(adapter.id);
  if (cached && cached.expiresAt > now) {
    const trend = getAdapterHealthTrend(adapter.id);
    return { ...cached.report, healthScore: trend.healthScore, trend: trend.trend, cached: true };
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!adapter.checkHealth) throw new Error("health check not implemented");
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("health check timed out")), options.timeoutMs ?? 5_000);
    });
    const health = await Promise.race([adapter.checkHealth(), timeout]);
    recordAdapterHealthEntry(adapter.id, health, options.historyWindowSize);
    const trend = getAdapterHealthTrend(adapter.id);
    const report: AdapterHealthReport = {
      adapterId: adapter.id,
      ...health,
      healthScore: trend.healthScore,
      trend: trend.trend,
      cached: false,
    };
    cache.set(adapter.id, { expiresAt: now + (options.cacheTtlMs ?? 60_000), report });
    return report;
  } catch (error) {
    const failedHealth: AdapterHealth = {
      available: false,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    recordAdapterHealthEntry(adapter.id, failedHealth, options.historyWindowSize);
    const trend = getAdapterHealthTrend(adapter.id);
    const report: AdapterHealthReport = {
      adapterId: adapter.id,
      ...failedHealth,
      healthScore: trend.healthScore,
      trend: trend.trend,
      cached: false,
    };
    cache.set(adapter.id, { expiresAt: now + (options.cacheTtlMs ?? 60_000), report });
    return report;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function checkAdaptersHealth(
  adapters: readonly DataAdapter[],
  options?: AdapterHealthCheckOptions,
): Promise<AdapterHealthReport[]> {
  return Promise.all(adapters.map((adapter) => checkAdapterHealth(adapter, options)));
}
