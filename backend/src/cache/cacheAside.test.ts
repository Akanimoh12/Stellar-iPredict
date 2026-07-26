import { describe, it, expect, beforeEach, vi } from "vitest";
import { getOrSet, withSingleFlight } from "../cache/cacheAside.js";

// ---------------------------------------------------------------------------
// Fake Redis — in-memory store with the ioredis surface used by getOrSet
// ---------------------------------------------------------------------------

function createFakeRedis() {
  const store = new Map<string, string>();

  return {
    _store: store,

    get: vi.fn(async (key: string): Promise<string | null> => {
      return store.get(key) ?? null;
    }),

    setex: vi.fn(
      async (key: string, _ttl: number, value: string): Promise<"OK"> => {
        store.set(key, value);
        return "OK";
      }
    ),
  };
}

// ---------------------------------------------------------------------------
// getOrSet
// ---------------------------------------------------------------------------

describe("getOrSet", () => {
  let redis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    redis = createFakeRedis();
  });

  it("returns the cached value on a hit without calling the loader", async () => {
    redis._store.set("mykey", JSON.stringify({ hello: "world" }));

    const loader = vi.fn(async () => ({ fallback: true }));
    const result = await getOrSet(redis as any, "mykey", 30, loader);

    expect(result).toEqual({ hello: "world" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("calls the loader on a miss and stores the result", async () => {
    const loader = vi.fn(async () => ({ fresh: "data" }));

    const result = await getOrSet(redis as any, "mykey", 30, loader);

    expect(result).toEqual({ fresh: "data" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledWith(
      "mykey",
      30,
      JSON.stringify({ fresh: "data" })
    );
    // Subsequent read should hit the cache.
    const cached = await getOrSet(redis as any, "mykey", 30, vi.fn());
    expect(cached).toEqual({ fresh: "data" });
  });

  it("uses the correct TTL when storing", async () => {
    await getOrSet(redis as any, "ttl-key", 42, async () => "val");

    expect(redis.setex).toHaveBeenCalledWith("ttl-key", 42, JSON.stringify("val"));
  });

  it("handles null / undefined loader results", async () => {
    await getOrSet(redis as any, "nullable", 10, async () => null);
    expect(redis.setex).toHaveBeenCalledWith("nullable", 10, "null");

    const cached = await getOrSet(redis as any, "nullable", 10, vi.fn());
    expect(cached).toBeNull();
  });

  it("handles primitive loader results (string, number, boolean)", async () => {
    // string
    await getOrSet(redis as any, "str", 10, async () => "hello");
    expect(redis.setex).toHaveBeenCalledWith("str", 10, '"hello"');

    // number
    await getOrSet(redis as any, "num", 10, async () => 42);
    expect(redis.setex).toHaveBeenCalledWith("num", 10, "42");

    // boolean
    await getOrSet(redis as any, "bool", 10, async () => true);
    expect(redis.setex).toHaveBeenCalledWith("bool", 10, "true");
  });

  it("propagates loader errors without caching", async () => {
    const loader = vi.fn(async () => {
      throw new Error("DB down");
    });

    await expect(
      getOrSet(redis as any, "errkey", 30, loader)
    ).rejects.toThrow("DB down");

    // The store should not be called because the loader threw.
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it("falls through to loader on corrupt JSON", async () => {
    redis._store.set("corrupt", "{not valid json");

    const loader = vi.fn(async () => "fresh");
    const result = await getOrSet(redis as any, "corrupt", 30, loader);

    expect(result).toBe("fresh");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("handles arrays as cache values", async () => {
    await getOrSet(redis as any, "arr", 10, async () => [1, 2, 3]);
    const cached = await getOrSet(redis as any, "arr", 10, vi.fn());
    expect(cached).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Single-flight (stampede protection)
// ---------------------------------------------------------------------------

describe("getOrSet — single-flight / stampede protection", () => {
  let redis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    redis = createFakeRedis();
  });

  it("deduplicates concurrent loader calls for the same key", async () => {
    let callCount = 0;
    const loader = vi.fn(async () => {
      callCount++;
      // Simulate a slow loader.
      await new Promise((r) => setTimeout(r, 20));
      return { from: "db" };
    });

    // Fire 5 concurrent getOrSet calls for the same key.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getOrSet(redis as any, "hot-key", 30, loader)
      )
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(1);
    // All callers receive the same value.
    for (const r of results) {
      expect(r).toEqual({ from: "db" });
    }
    // Only one SETEX call.
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it("does NOT deduplicate calls for different keys", async () => {
    const loaderA = vi.fn(async () => "a");
    const loaderB = vi.fn(async () => "b");

    const [a, b] = await Promise.all([
      getOrSet(redis as any, "key-a", 30, loaderA),
      getOrSet(redis as any, "key-b", 30, loaderB),
    ]);

    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(1);
  });

  it("allows a new loader after the in-flight one settles", async () => {
    let callCount = 0;
    const loader = vi.fn(async () => {
      callCount++;
      return "value";
    });

    // Batch 1.
    await Promise.all([
      getOrSet(redis as any, "retry-key", 30, loader),
      getOrSet(redis as any, "retry-key", 30, loader),
    ]);
    expect(callCount).toBe(1);

    // Clear the cache so we get a miss again.
    redis._store.delete("retry-key");

    // Batch 2 — should call the loader again (once).
    await Promise.all([
      getOrSet(redis as any, "retry-key", 30, loader),
      getOrSet(redis as any, "retry-key", 30, loader),
    ]);
    expect(callCount).toBe(2);
  });

  it("propagates loader errors to all concurrent waiters", async () => {
    let callCount = 0;
    const loader = vi.fn(async () => {
      callCount++;
      throw new Error("transient failure");
    });

    const results = await Promise.allSettled([
      getOrSet(redis as any, "failing-key", 30, loader),
      getOrSet(redis as any, "failing-key", 30, loader),
      getOrSet(redis as any, "failing-key", 30, loader),
    ]);

    // Loader called only once even though 3 callers waited.
    expect(callCount).toBe(1);

    // All 3 callers receive the same error.
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect(r.reason.message).toBe("transient failure");
      }
    }

    // Nothing stored in Redis on failure.
    expect(redis.setex).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withSingleFlight — low-level unit tests
// ---------------------------------------------------------------------------

describe("withSingleFlight", () => {
  it("executes the function and returns its result", async () => {
    const fn = vi.fn(async () => 42);
    const result = await withSingleFlight("key", "test", fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent calls with the same scope+key", async () => {
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    });

    const results = await Promise.all([
      withSingleFlight("dup", "test", fn),
      withSingleFlight("dup", "test", fn),
      withSingleFlight("dup", "test", fn),
    ]);

    expect(callCount).toBe(1);
    for (const r of results) {
      expect(r).toBe("ok");
    }
  });

  it("allows a new execution after the first settles", async () => {
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      return "done";
    });

    await withSingleFlight("retry", "test", fn);
    expect(callCount).toBe(1);

    await withSingleFlight("retry", "test", fn);
    expect(callCount).toBe(2);
  });
});
