const CACHE_PREFIX = "ip_";
const DEFAULT_TTL = 30_000; // 30 seconds

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

/** Get a cached value. Returns null if expired or not found. */
export function get<T>(key: string): T | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;

    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() > entry.expiry) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

/** Set a cached value with optional TTL in milliseconds. */
export function set<T>(key: string, data: T, ttl = DEFAULT_TTL): void {
  if (typeof window === "undefined") return;

  const entry: CacheEntry<T> = {
    data,
    expiry: Date.now() + ttl,
  };
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
  } catch {
    // localStorage might be full — silently fail
  }
}

/** Invalidate a specific cache key. */
export function invalidate(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CACHE_PREFIX + key);
}

/** Invalidate all iPredict cache entries. */
export function invalidateAll(): void {
  if (typeof window === "undefined") return;

  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(CACHE_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}
