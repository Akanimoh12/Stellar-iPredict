import type { AdapterHealth, DataAdapter } from "./index.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./httpRetry.js";

export interface AdapterHealthReport extends AdapterHealth {
  adapterId: string;
  cached: boolean;
}

export interface AdapterHealthCheckOptions {
  /** Avoid repeatedly consuming provider quota. Defaults to 60 seconds. */
  cacheTtlMs?: number;
  timeoutMs?: number;
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
  if (cached && cached.expiresAt > now) return { ...cached.report, cached: true };

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!adapter.checkHealth) throw new Error("health check not implemented");
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("health check timed out")), options.timeoutMs ?? 5_000);
    });
    const health = await Promise.race([adapter.checkHealth(), timeout]);
    const report = { adapterId: adapter.id, ...health, cached: false };
    cache.set(adapter.id, { expiresAt: now + (options.cacheTtlMs ?? 60_000), report });
    return report;
  } catch (error) {
    const report: AdapterHealthReport = {
      adapterId: adapter.id,
      available: false,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
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
