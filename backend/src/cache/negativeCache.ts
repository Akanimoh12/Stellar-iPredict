/**
 * Negative cache — briefly caches "not found" results to prevent repeated
 * database lookups for resources that do not exist.
 *
 * Without this, a bot or misbehaving client requesting `/api/v1/markets/99999`
 * in a tight loop would hammer the database with identical queries that always
 * return zero rows.  By caching the miss for a short TTL the DB is shielded
 * and the response latency drops to near-zero for repeated 404s.
 *
 * The cache uses lazy eviction: expired entries are pruned on read and a
 * periodic sweep runs at a configurable interval to bound memory.
 *
 * @see docs/ORACLE_AND_BACKEND.md §Caching Strategy
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default time-to-live for negative cache entries (30 seconds). */
export const NEGATIVE_CACHE_TTL_MS = 30_000;

/** How often the background sweep prunes expired entries (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Timestamp (ms since epoch) when this entry expires. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// NegativeCache
// ---------------------------------------------------------------------------

/**
 * In-memory TTL cache for recording "resource not found" responses.
 *
 * Each instance maintains its own store and sweep timer.  Call
 * {@link destroy} before discarding an instance to clear the timer.
 */
export class NegativeCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(defaultTtlMs: number = NEGATIVE_CACHE_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
    this.startSweep();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Record a cache miss for {@link key}.  Subsequent calls to
   * {@link isCachedMiss} will return `true` until the TTL elapses.
   */
  markMiss(key: string, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, { expiresAt: Date.now() + ttl });
  }

  /**
   * Returns `true` if {@link key} is a cached miss that has not yet expired.
   * Lazily evicts the entry when it is stale.
   */
  isCachedMiss(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) return false;

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Remove a specific entry — call when the resource is created so that the
   * next lookup goes through to the database.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Flush every entry. */
  clear(): void {
    this.store.clear();
  }

  /** Number of (potentially expired) entries currently in the store. */
  get size(): number {
    return this.store.size;
  }

  /** Stop the background sweep timer.  Safe to call multiple times. */
  destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Remove all expired entries in one pass. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  private startSweep(): void {
    // unref() ensures the timer does not prevent Node from exiting.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }
}
