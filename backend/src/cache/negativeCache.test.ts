import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NegativeCache, NEGATIVE_CACHE_TTL_MS } from "../cache/negativeCache.js";

let cache: NegativeCache;

beforeEach(() => {
  vi.useFakeTimers();
  cache = new NegativeCache();
});

afterEach(() => {
  cache.destroy();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe("NegativeCache", () => {
  it("detects a cached miss", () => {
    cache.markMiss("market:999");
    expect(cache.isCachedMiss("market:999")).toBe(true);
  });

  it("returns false for keys that were never cached", () => {
    expect(cache.isCachedMiss("market:1")).toBe(false);
  });

  it("expires entries after the default TTL", () => {
    cache.markMiss("market:999");

    // Just before expiry — still cached.
    vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS - 1);
    expect(cache.isCachedMiss("market:999")).toBe(true);

    // At expiry — lazily evicted on read.
    vi.advanceTimersByTime(1);
    expect(cache.isCachedMiss("market:999")).toBe(false);
  });

  it("respects a custom TTL per entry", () => {
    cache.markMiss("market:42", 5_000);

    vi.advanceTimersByTime(4_999);
    expect(cache.isCachedMiss("market:42")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(cache.isCachedMiss("market:42")).toBe(false);
  });

  it("invalidate() removes a cached miss immediately", () => {
    cache.markMiss("market:999");
    expect(cache.isCachedMiss("market:999")).toBe(true);

    cache.invalidate("market:999");
    expect(cache.isCachedMiss("market:999")).toBe(false);
  });

  it("invalidate() is a no-op for unknown keys", () => {
    expect(() => cache.invalidate("nope")).not.toThrow();
  });

  it("clear() flushes all entries", () => {
    cache.markMiss("a");
    cache.markMiss("b");
    cache.markMiss("c");
    expect(cache.size).toBe(3);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.isCachedMiss("a")).toBe(false);
  });

  it("overwriting a miss resets the TTL", () => {
    cache.markMiss("market:1", 10_000);
    vi.advanceTimersByTime(9_000); // 1 s left on original TTL

    // Re-mark with a fresh 10 s TTL.
    cache.markMiss("market:1", 10_000);
    vi.advanceTimersByTime(5_000);
    expect(cache.isCachedMiss("market:1")).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(cache.isCachedMiss("market:1")).toBe(false);
  });

  it("tracks size correctly across operations", () => {
    expect(cache.size).toBe(0);

    cache.markMiss("a");
    cache.markMiss("b");
    expect(cache.size).toBe(2);

    cache.invalidate("a");
    expect(cache.size).toBe(1);
  });

  describe("metrics", () => {
    it("starts with 0 hits, 0 misses, and a hit rate of 0", () => {
      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
      expect(metrics.hitRate).toBe(0);
    });

    it("tracks hits when queries are cached", () => {
      cache.markMiss("market:999");
      expect(cache.isCachedMiss("market:999")).toBe(true);
      
      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(1);
      expect(metrics.misses).toBe(0);
      expect(metrics.hitRate).toBe(1.0);
    });

    it("tracks misses when queries are not cached", () => {
      expect(cache.isCachedMiss("market:notexists")).toBe(false);
      
      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRate).toBe(0);
    });

    it("tracks misses when queries are expired", () => {
      cache.markMiss("market:999");
      vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS + 100);
      expect(cache.isCachedMiss("market:999")).toBe(false);
      
      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRate).toBe(0);
    });

    it("calculates partial hit rate correctly", () => {
      cache.markMiss("market:999");
      
      expect(cache.isCachedMiss("market:999")).toBe(true);
      expect(cache.isCachedMiss("market:notexists")).toBe(false);
      
      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(1);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRate).toBe(0.5);
    });
  });
});

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

describe("NegativeCache constructor", () => {
  it("uses NEGATIVE_CACHE_TTL_MS as the default", () => {
    // Already tested implicitly, but let's be explicit about the exported constant.
    expect(NEGATIVE_CACHE_TTL_MS).toBe(30_000);
  });

  it("accepts a custom default TTL", () => {
    const short = new NegativeCache(1_000);
    short.markMiss("x");

    vi.advanceTimersByTime(999);
    expect(short.isCachedMiss("x")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(short.isCachedMiss("x")).toBe(false);

    short.destroy();
  });
});
