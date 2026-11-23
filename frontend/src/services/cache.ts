const CACHE_PREFIX = "ip_";
const DEFAULT_TTL = 30_000; // 30 seconds

/**
 * How long we stay in "degraded" mode before re-probing the persistent tier.
 * Storage outages are usually transient (quota pressure, a private-mode tab
 * that gets granted storage later), so we retry — but not on every single read,
 * because a throwing localStorage is expensive and noisy.
 */
const DEGRADE_RETRY_MS = 60_000;
const PROBE_KEY = CACHE_PREFIX + "__probe__";

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

// ── Two-tier cache ──────────────────────────────────────────────────────────
// Tier 1: in-memory Map — instant, survives client-side navigation (SPA), no
//         JSON parse cost. This is what makes returning to a page feel instant.
// Tier 2: localStorage — survives full page reloads / new tabs.
//
// Reads check memory first (synchronous, microseconds), then fall back to
// localStorage (re-hydrating memory). Writes update both.
const memory = new Map<string, CacheEntry<unknown>>();

/** In-flight loaders, keyed by cache key — see `getOrSet`. */
const inflight = new Map<string, Promise<unknown>>();

// ── Graceful degradation ────────────────────────────────────────────────────
// The persistent tier is the part of this cache that can actually fail:
// Safari private mode throws on write, users disable site data, quota fills up,
// and extensions replace `localStorage` with a stub that throws.
//
// When that happens the cache must NOT take the app down with it. We:
//   1. catch the failure at the single choke point (`storage()` + op wrappers),
//   2. log it ONCE (repeated warnings on a hot read path are just noise),
//   3. keep serving from the in-memory tier, and fall through to the source of
//      truth (the RPC) on a miss — correctness is unaffected, only the "survives
//      a reload" property is lost,
//   4. re-probe after DEGRADE_RETRY_MS so a transient outage self-heals.

let degraded = false;
let degradedSince = 0;
let degradedReason: string | null = null;

/** Snapshot of persistent-tier health — useful in tests and debug overlays. */
export function getCacheHealth(): {
  persistent: boolean;
  reason: string | null;
  since: number | null;
} {
  return {
    persistent: !degraded,
    reason: degradedReason,
    since: degraded ? degradedSince : null,
  };
}

/**
 * Force the persistent tier back to "healthy, untested". Call after the user
 * re-enables site storage; tests use it to isolate cases.
 */
export function resetCacheHealth(): void {
  degraded = false;
  degradedSince = 0;
  degradedReason = null;
}

function markDegraded(reason: string, err: unknown): void {
  const first = !degraded;
  degraded = true;
  degradedSince = Date.now();
  degradedReason = reason;
  if (first) {
    console.warn(
      `[iPredict][cache] persistent tier unavailable (${reason}) — falling back ` +
        `to the in-memory cache and to the network on a miss. Cached data will ` +
        `not survive a reload until storage recovers.`,
      err
    );
  }
}

function markRecovered(): void {
  if (!degraded) return;
  degraded = false;
  degradedReason = null;
  console.info("[iPredict][cache] persistent tier recovered");
}

/**
 * The persistent tier, or null when it is unavailable/degraded/SSR.
 * Every localStorage access in this module goes through here.
 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null;

  if (degraded) {
    // Still inside the cool-down — stay on the memory-only path.
    if (Date.now() - degradedSince < DEGRADE_RETRY_MS) return null;
    // Cool-down elapsed: probe with a real write, because private-mode
    // localStorage reads fine and only throws when you write to it.
    try {
      const ls = window.localStorage;
      ls.setItem(PROBE_KEY, "1");
      ls.removeItem(PROBE_KEY);
      markRecovered();
      return ls;
    } catch (err) {
      markDegraded("probe-failed", err);
      return null;
    }
  }

  try {
    return window.localStorage ?? null;
  } catch (err) {
    // Accessing the property itself can throw when site data is blocked.
    markDegraded("access-denied", err);
    return null;
  }
}

/** Read an entry from either tier, ignoring expiry. Null when absent. */
function peek<T>(key: string): CacheEntry<T> | null {
  const mem = memory.get(key);
  if (mem) return mem as CacheEntry<T>;

  const ls = storage();
  if (!ls) return null;

  let raw: string | null = null;
  try {
    raw = ls.getItem(CACHE_PREFIX + key);
  } catch (err) {
    markDegraded("read-failed", err);
    return null;
  }
  if (!raw) return null;

  try {
    const entry = JSON.parse(raw) as CacheEntry<T>;
    // Corrupt / foreign value under our prefix — not a storage outage.
    if (!entry || typeof entry.expiry !== "number") {
      removeFromStorage(key);
      return null;
    }
    memory.set(key, entry); // re-hydrate tier 1
    return entry;
  } catch {
    removeFromStorage(key);
    return null;
  }
}

function removeFromStorage(key: string): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(CACHE_PREFIX + key);
  } catch (err) {
    markDegraded("delete-failed", err);
  }
}

/** Get a cached value. Returns null if expired or not found. */
export function get<T>(key: string): T | null {
  const entry = peek<T>(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    invalidate(key);
    return null;
  }
  return entry.data;
}

/**
 * Get a value even if expired (stale). Used for stale-while-revalidate:
 * show stale data instantly, refresh in the background.
 */
export function getStale<T>(key: string): T | null {
  const entry = peek<T>(key);
  return entry ? entry.data : null;
}

/** Set a cached value with optional TTL in milliseconds. */
export function set<T>(key: string, data: T, ttl = DEFAULT_TTL): void {
  const entry: CacheEntry<T> = { data, expiry: Date.now() + ttl };
  memory.set(key, entry); // tier 1 — always available, even SSR

  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
  } catch (err) {
    // Quota exceeded, private mode, or storage disabled mid-session. The
    // memory tier still holds the value, so this is a downgrade, not a failure.
    markDegraded("write-failed", err);
  }
}

/**
 * Read-through cache: return the cached value, otherwise run `loader`, store
 * the result, and return it.
 *
 * Two properties matter more than the caching itself:
 *  - **De-duplication.** Concurrent callers for the same key share ONE loader
 *    call. Twelve components mounting at once against a cold cache produce one
 *    RPC request, not twelve.
 *  - **Serve-stale-on-error.** If the loader throws but we still hold an
 *    expired copy, the stale copy is returned instead of the error. On a read
 *    path, slightly old data beats an empty screen. Callers that need to know
 *    about the failure get the rejection when there is nothing cached at all.
 */
export async function getOrSet<T>(
  key: string,
  loader: () => Promise<T>,
  ttl = DEFAULT_TTL
): Promise<T> {
  const fresh = peek<T>(key);
  if (fresh && Date.now() <= fresh.expiry) return fresh.data;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  // Start the loader in a microtask (`Promise.resolve().then`) rather than
  // inline: a loader that throws SYNCHRONOUSLY would otherwise run its cleanup
  // before `promise` below is even assigned, and we'd leave a permanently
  // rejected entry in the in-flight map.
  const promise: Promise<T> = Promise.resolve()
    .then(loader)
    .then((data) => {
      set(key, data, ttl);
      return data;
    })
    .catch((err: unknown) => {
      const stale = peek<T>(key);
      if (stale) {
        console.warn(
          `[iPredict][cache] loader failed for "${key}" — serving stale value`,
          err
        );
        return stale.data;
      }
      throw err;
    })
    .finally(() => {
      // Only clear our OWN entry — `invalidate` may have replaced it already.
      if (inflight.get(key) === promise) inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/** Invalidate a specific cache key (both tiers, plus any in-flight loader). */
export function invalidate(key: string): void {
  memory.delete(key);
  inflight.delete(key);
  removeFromStorage(key);
}

/** Invalidate all iPredict cache entries (both tiers). */
export function invalidateAll(): void {
  memory.clear();
  inflight.clear();

  const ls = storage();
  if (!ls) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key?.startsWith(CACHE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => ls.removeItem(key));
  } catch (err) {
    markDegraded("clear-failed", err);
  }
}
