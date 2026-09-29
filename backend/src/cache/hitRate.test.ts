/**
 * Cache hit-rate metric — issue #214.
 *
 * Covers the accounting itself, the exposition format, and the wiring into
 * `getOrSet` (the read path every cached route goes through).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrSet } from "./cacheAside.js";
import {
  CACHE_NAMESPACES,
  cacheNamespaceOf,
  computeHitRate,
  getCacheHitRate,
  getCacheStats,
  recordCacheHit,
  recordCacheMiss,
  resetCacheStats,
  serializeCacheMetrics,
} from "./hitRate.js";
import {
  getNegativeCacheStats,
  resetNegativeCacheStats,
  serializeNegativeCacheMetrics,
} from "./negativeCache.js";
import {
  betsKey,
  cacheKey,
  leaderboardKey,
  marketKey,
  oddsKey,
  statsKey,
  statusKey,
} from "./keys.js";

beforeEach(() => {
  resetCacheStats();
  resetNegativeCacheStats();
});

/** Parse an exposition body into `name{labels} -> value`. */
function parseExposition(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.lastIndexOf(" ");
    out[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return out;
}

function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK" as const;
    }),
  };
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

describe("cache hit-rate accounting", () => {
  it("starts at NaN rather than 0", () => {
    // A backend that has served no traffic has not achieved a 0% hit rate,
    // and emitting 0 would fire a low-hit-rate alert on every deploy.
    expect(getCacheHitRate()).toBeNaN();
    expect(getCacheStats().lookups).toBe(0);
  });

  it("computes hits / (hits + misses)", () => {
    for (let i = 0; i < 3; i++) recordCacheHit(marketKey(1));
    recordCacheMiss(marketKey(2));

    const stats = getCacheStats();
    expect(stats).toMatchObject({ hits: 3, misses: 1, lookups: 4, hitRate: 0.75 });
    expect(getCacheHitRate()).toBe(0.75);
  });

  it("computeHitRate is NaN only at zero lookups", () => {
    expect(computeHitRate(0, 0)).toBeNaN();
    expect(computeHitRate(0, 5)).toBe(0);
    expect(computeHitRate(5, 0)).toBe(1);
  });

  it("resetCacheStats clears totals and namespaces", () => {
    recordCacheHit(statsKey());
    resetCacheStats();

    expect(getCacheStats().byNamespace).toEqual([]);
    expect(getCacheHitRate()).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

describe("cacheNamespaceOf", () => {
  it("reads the entity segment out of every key helper in keys.ts", () => {
    expect(cacheNamespaceOf(marketKey(7))).toBe("market");
    expect(cacheNamespaceOf(leaderboardKey())).toBe("leaderboard");
    expect(cacheNamespaceOf(statsKey())).toBe("stats");
    expect(cacheNamespaceOf(betsKey(7))).toBe("bets");
    expect(cacheNamespaceOf(statusKey())).toBe("status");
    expect(cacheNamespaceOf(oddsKey(7))).toBe("odds");
  });

  it("namespaces every entity in CACHE_ENTITIES, so none collapse into `other`", () => {
    // The whole point of the per-namespace breakdown is to say *which* key
    // structure broke. An entity whose keys land in `other` cannot be named
    // by the alert or the dashboard, which is how the list and the key
    // builders drift apart unnoticed.
    for (const entity of CACHE_NAMESPACES) {
      expect(cacheNamespaceOf(cacheKey(entity, "1"))).toBe(entity);
    }
  });

  it("buckets anything unrecognised as `other` instead of a new series", () => {
    // The namespace is a Prometheus label, and keys embed market ids — an
    // open-ended label would be one series per market.
    expect(cacheNamespaceOf("ipredict:v1:something-new:1")).toBe("other");
    expect(cacheNamespaceOf("legacy-key")).toBe("other");
    expect(cacheNamespaceOf("")).toBe("other");
  });

  it("never returns a namespace outside the closed list", () => {
    const allowed = new Set<string>([...CACHE_NAMESPACES, "other"]);
    for (const key of ["ipredict:v9:market:1", "a:b:c:d", "::", "x"]) {
      expect(allowed.has(cacheNamespaceOf(key))).toBe(true);
    }
  });

  it("breaks the counts down per namespace", () => {
    recordCacheHit(marketKey(1));
    recordCacheHit(marketKey(2));
    recordCacheMiss(marketKey(3));
    recordCacheHit(statsKey());

    expect(getCacheStats().byNamespace).toEqual([
      { namespace: "market", hits: 2, misses: 1, lookups: 3, hitRate: 2 / 3 },
      { namespace: "stats", hits: 1, misses: 0, lookups: 1, hitRate: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Exposition
// ---------------------------------------------------------------------------

describe("serializeCacheMetrics", () => {
  it("emits cache_hit_rate as NaN before any lookup", () => {
    const samples = parseExposition(serializeCacheMetrics());

    expect(samples.cache_hit_rate).toBe("NaN");
    expect(samples.cache_hits_total).toBe("0");
    expect(samples.cache_misses_total).toBe("0");
  });

  it("emits the gauge, the counters, and the namespace breakdown", () => {
    recordCacheHit(marketKey(1));
    recordCacheHit(marketKey(2));
    recordCacheMiss(leaderboardKey());

    const body = serializeCacheMetrics();
    const samples = parseExposition(body);

    expect(samples.cache_hit_rate).toBe(String(2 / 3));
    expect(samples.cache_hits_total).toBe("2");
    expect(samples.cache_misses_total).toBe("1");
    expect(samples['cache_namespace_hits_total{namespace="market"}']).toBe("2");
    expect(samples['cache_namespace_misses_total{namespace="leaderboard"}']).toBe("1");

    expect(body).toContain("# TYPE cache_hit_rate gauge");
    expect(body).toContain("# TYPE cache_hits_total counter");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("never mixes labelled and unlabelled samples under one metric name", () => {
    // Prometheus rejects the whole scrape for that, so the per-namespace
    // series use their own metric names.
    recordCacheHit(marketKey(1));

    for (const line of serializeCacheMetrics().split("\n")) {
      if (line.startsWith("cache_hit_rate")) expect(line).not.toContain("{");
      if (line.startsWith("cache_hits_total")) expect(line).not.toContain("{");
      if (line.startsWith("cache_misses_total")) expect(line).not.toContain("{");
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring into the read path
// ---------------------------------------------------------------------------

describe("getOrSet records hits and misses", () => {
  it("counts a populated key as a hit and does not call the loader", async () => {
    const redis = createFakeRedis();
    const key = marketKey(1);
    redis._store.set(key, JSON.stringify({ id: 1 }));

    await getOrSet(redis as never, key, 30, async () => ({ id: 0 }));

    expect(getCacheStats()).toMatchObject({ hits: 1, misses: 0, hitRate: 1 });
  });

  it("counts an absent key as a miss", async () => {
    const redis = createFakeRedis();

    await getOrSet(redis as never, marketKey(1), 30, async () => ({ id: 1 }));

    expect(getCacheStats()).toMatchObject({ hits: 0, misses: 1, hitRate: 0 });
  });

  it("counts a corrupt entry as a miss, because the loader still ran", async () => {
    const redis = createFakeRedis();
    const key = marketKey(1);
    redis._store.set(key, "{not json");
    const loader = vi.fn(async () => ({ id: 1 }));

    await getOrSet(redis as never, key, 30, loader);

    expect(loader).toHaveBeenCalledOnce();
    expect(getCacheStats()).toMatchObject({ hits: 0, misses: 1 });
  });

  it("counts a miss then a hit across two calls for the same key", async () => {
    const redis = createFakeRedis();
    const key = statsKey();

    await getOrSet(redis as never, key, 30, async () => ({ total: 1 }));
    await getOrSet(redis as never, key, 30, async () => ({ total: 2 }));

    expect(getCacheStats()).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5 });
  });

  it("counts every concurrent caller of a cold key as its own miss", async () => {
    // All three consulted Redis and all three found nothing; single-flight
    // dedupes the *loader*, not the lookups.
    const redis = createFakeRedis();
    const key = betsKey(1);

    await Promise.all(
      Array.from({ length: 3 }, () => getOrSet(redis as never, key, 30, async () => [])),
    );

    expect(getCacheStats().misses).toBe(3);
  });

  it("does not count a Redis failure as a miss", async () => {
    // A cache outage must not read as a cold cache.
    const redis = {
      get: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      setex: vi.fn(),
    };

    const result = await getOrSet(redis as never, marketKey(1), 30, async () => ({ id: 1 }));
    expect(result).toEqual({ id: 1 });

    expect(getCacheStats().lookups).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative lookups — counted separately from the ordinary hit rate
// ---------------------------------------------------------------------------

describe("getOrSet classifies not-found values as negative-cache lookups", () => {
  it("counts a stored `null` as a negative-cache hit and leaves the cache counters alone", async () => {
    const redis = createFakeRedis();
    const key = marketKey(999);
    redis._store.set(key, "null");
    const loader = vi.fn(async () => ({ id: 999 }));

    const value = await getOrSet(redis as never, key, 30, loader);

    expect(value).toBeNull();
    expect(loader).not.toHaveBeenCalled();

    // Not a hit: Redis did not serve a resource, it served "not found".
    expect(getCacheStats().lookups).toBe(0);
    expect(getNegativeCacheStats()).toMatchObject({
      hits: 1,
      misses: 0,
      lookups: 1,
      hitRate: 1,
    });
  });

  it("counts a loader that resolves to `null` as a negative-cache miss", async () => {
    const redis = createFakeRedis();

    const value = await getOrSet(redis as never, marketKey(404), 30, async () => null);

    expect(value).toBeNull();
    // The cache did not have to serve a resource, so the ordinary hit rate
    // must not move — otherwise a burst of 404s drags it down (or a burst of
    // cached 404s props it up) and hides the real signal.
    expect(getCacheStats().lookups).toBe(0);
    expect(getNegativeCacheStats()).toMatchObject({ hits: 0, misses: 1, lookups: 1 });
  });

  it("then serves the stored `null` as a negative-cache hit", async () => {
    const redis = createFakeRedis();
    const key = marketKey(404);

    await getOrSet(redis as never, key, 30, async () => null);
    await getOrSet(redis as never, key, 30, async () => null);

    expect(getNegativeCacheStats()).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5 });
    expect(getCacheStats().lookups).toBe(0);
  });

  it("counts each concurrent caller of a cold null-returning key as its own negative miss", async () => {
    const redis = createFakeRedis();
    const key = betsKey(9999);

    await Promise.all(
      Array.from({ length: 3 }, () => getOrSet(redis as never, key, 30, async () => null)),
    );

    expect(getNegativeCacheStats().misses).toBe(3);
    expect(getCacheStats().lookups).toBe(0);
  });

  it("counts a rejecting loader as an ordinary miss — the failure is not a not-found", async () => {
    const redis = createFakeRedis();

    await expect(
      getOrSet(redis as never, marketKey(1), 30, async () => {
        throw new Error("database down");
      }),
    ).rejects.toThrow("database down");

    expect(getCacheStats()).toMatchObject({ misses: 1, lookups: 1 });
    expect(getNegativeCacheStats().lookups).toBe(0);
  });

  it("does not touch either family when Redis cannot be consulted", async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      setex: vi.fn(),
    };

    await getOrSet(redis as never, marketKey(1), 30, async () => null);

    expect(getCacheStats().lookups).toBe(0);
    expect(getNegativeCacheStats().lookups).toBe(0);
  });

  it("exposes the negative cache as its own metric family", async () => {
    const redis = createFakeRedis();
    await getOrSet(redis as never, marketKey(1), 30, async () => null);
    await getOrSet(redis as never, marketKey(1), 30, async () => null);

    const samples = parseExposition(serializeNegativeCacheMetrics());

    expect(samples.negative_cache_hit_rate).toBe("0.5");
    expect(samples.negative_cache_hits_total).toBe("1");
    expect(samples.negative_cache_misses_total).toBe("1");
    expect(samples['negative_cache_namespace_hits_total{namespace="market"}']).toBe("1");
    expect(samples['negative_cache_namespace_misses_total{namespace="market"}']).toBe("1");

    // Never mixed with the ordinary cache metrics under one metric name.
    for (const line of serializeCacheMetrics().split("\n")) {
      expect(line.startsWith("negative_cache")).toBe(false);
    }
  });
});
