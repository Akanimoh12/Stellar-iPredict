import type { Market } from "./index.js";

export const DEFAULT_ADAPTER_CACHE_TTL_MS = 5_000;

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

/** Builds a key from the provider request parameters, excluding market id and derived outcome parameters. */
export function marketCacheKey(market: Market): string {
  const providerParams = Object.fromEntries(
    Object.entries(market.params).filter(([key]) => key !== "comparator" && key !== "threshold"),
  );
  return stableSerialize({ category: market.category, params: providerParams });
}

/**
 * Small in-memory TTL cache for adapter responses.
 * In-flight requests share one promise, preventing concurrent quota usage.
 */
export class AdapterResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_ADAPTER_CACHE_TTL_MS) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  }

  getOrSet(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.ttlMs === 0) {
      return loader();
    }

    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.value;
    }

    const value = loader();
    const entry: CacheEntry<T> = {
      expiresAt: Number.POSITIVE_INFINITY,
      value,
    };
    this.entries.set(key, entry);

    void value.then(
      () => {
        if (this.entries.get(key) === entry) {
          entry.expiresAt = Date.now() + this.ttlMs;
        }
      },
      () => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      },
    );

    return value;
  }
}
