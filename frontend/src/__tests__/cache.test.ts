import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  get,
  getStale,
  getOrSet,
  set,
  invalidate,
  invalidateAll,
  getCacheHealth,
  resetCacheHealth,
} from "@/services/cache";

// ── localStorage mock ─────────────────────────────────────────────────────────

let store: Record<string, string> = {};

function installLocalStorageMock() {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      clear: () => {
        store = {};
      },
    },
    writable: true,
    configurable: true,
  });
}

/**
 * localStorage that throws on the given operations — models Safari private
 * mode, a full quota, or site data blocked by the user.
 */
function installFailingLocalStorageMock(
  failing: Array<"getItem" | "setItem" | "removeItem"> = ["setItem"]
) {
  const boom = (op: string) => () => {
    throw new DOMException(`${op} failed`, "QuotaExceededError");
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: failing.includes("getItem")
        ? boom("getItem")
        : (key: string) => store[key] ?? null,
      setItem: failing.includes("setItem")
        ? boom("setItem")
        : (key: string, val: string) => {
            store[key] = val;
          },
      removeItem: failing.includes("removeItem")
        ? boom("removeItem")
        : (key: string) => {
            delete store[key];
          },
      get length() {
        return Object.keys(store).length;
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      clear: () => {
        store = {};
      },
    },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  store = {};
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-26T00:00:00Z"));
  installLocalStorageMock();
  // The memory tier and the degradation flag are module-level singletons —
  // reset both so cases can't leak into each other.
  resetCacheHealth();
  invalidateAll();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Basic CRUD ────────────────────────────────────────────────────────────────

describe("cache – basic CRUD", () => {
  it("stores and retrieves a value within TTL", () => {
    set("testKey", { foo: "bar" });
    expect(get("testKey")).toEqual({ foo: "bar" });
  });

  it("returns null for missing key", () => {
    expect(get("nonexistent")).toBeNull();
  });

  it("stores string values correctly", () => {
    set("str", "hello");
    expect(get("str")).toBe("hello");
  });

  it("stores numeric values correctly", () => {
    set("num", 42);
    expect(get("num")).toBe(42);
  });

  it("stores arrays correctly", () => {
    set("arr", [1, 2, 3]);
    expect(get("arr")).toEqual([1, 2, 3]);
  });

  it("prefixes keys with ip_ in localStorage", () => {
    set("myKey", "data");
    expect(store["ip_myKey"]).toBeDefined();
    expect(store["myKey"]).toBeUndefined();
  });
});

// ── TTL expiry ────────────────────────────────────────────────────────────────

describe("cache – TTL expiry", () => {
  it("returns value before TTL expires", () => {
    set("fresh", "data", 5000);
    vi.advanceTimersByTime(4999);
    expect(get("fresh")).toBe("data");
  });

  it("returns null after TTL expires", () => {
    set("stale", "data", 5000);
    vi.advanceTimersByTime(5001);
    expect(get("stale")).toBeNull();
  });

  it("cleans up expired entry from localStorage on read", () => {
    set("cleanup", "data", 1000);
    vi.advanceTimersByTime(1001);
    get("cleanup"); // triggers cleanup
    expect(store["ip_cleanup"]).toBeUndefined();
  });

  it("uses default TTL of 30 seconds when not specified", () => {
    set("defaultTTL", "data");
    vi.advanceTimersByTime(29_999);
    expect(get("defaultTTL")).toBe("data");
    vi.advanceTimersByTime(2);
    expect(get("defaultTTL")).toBeNull();
  });

  it("supports custom TTL (60s for leaderboard)", () => {
    set("leaderboard", "rankings", 60_000);
    vi.advanceTimersByTime(59_999);
    expect(get("leaderboard")).toBe("rankings");
    vi.advanceTimersByTime(2);
    expect(get("leaderboard")).toBeNull();
  });

  it("returns null for already-expired entry (negative TTL)", () => {
    set("instant", "data", -1);
    expect(get("instant")).toBeNull();
  });
});

// ── Invalidation ──────────────────────────────────────────────────────────────

describe("cache – invalidation", () => {
  it("invalidates a specific key", () => {
    set("toRemove", "data");
    invalidate("toRemove");
    expect(get("toRemove")).toBeNull();
  });

  it("does not affect other keys when invalidating one", () => {
    set("keep", "yes");
    set("remove", "no");
    invalidate("remove");
    expect(get("keep")).toBe("yes");
  });

  it("invalidates all ip_ prefixed keys", () => {
    set("a", 1);
    set("b", 2);
    set("c", 3);
    invalidateAll();
    expect(get("a")).toBeNull();
    expect(get("b")).toBeNull();
    expect(get("c")).toBeNull();
  });

  it("invalidateAll does not remove non-ip_ keys", () => {
    set("cached", "yes");
    store["other_key"] = "external";
    invalidateAll();
    expect(store["other_key"]).toBe("external");
  });
});

// ── JSON serialization edge cases ─────────────────────────────────────────────

describe("cache – JSON serialization", () => {
  it("handles nested objects", () => {
    const complex = { market: { id: 1, bets: [{ amount: 50 }] } };
    set("nested", complex);
    expect(get("nested")).toEqual(complex);
  });

  it("returns null for corrupted JSON in localStorage", () => {
    store["ip_corrupt"] = "not valid json {{{";
    expect(get("corrupt")).toBeNull();
  });
});

// ── getOrSet (read-through) ───────────────────────────────────────────────────

describe("cache – getOrSet", () => {
  it("runs the loader on a miss and caches the result", async () => {
    const loader = vi.fn().mockResolvedValue({ id: 1 });

    expect(await getOrSet("gos_miss", loader)).toEqual({ id: 1 });
    expect(await getOrSet("gos_miss", loader)).toEqual({ id: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store["ip_gos_miss"]).toBeDefined();
  });

  it("does not run the loader while the entry is fresh", async () => {
    set("gos_fresh", "cached", 5000);
    const loader = vi.fn().mockResolvedValue("loaded");

    expect(await getOrSet("gos_fresh", loader, 5000)).toBe("cached");
    expect(loader).not.toHaveBeenCalled();
  });

  it("re-runs the loader once the TTL has expired", async () => {
    const loader = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");

    expect(await getOrSet("gos_ttl", loader, 1000)).toBe("first");
    vi.advanceTimersByTime(1001);
    expect(await getOrSet("gos_ttl", loader, 1000)).toBe("second");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("caches falsy values instead of re-fetching them", async () => {
    const loader = vi.fn().mockResolvedValue(0);

    expect(await getOrSet("gos_zero", loader)).toBe(0);
    expect(await getOrSet("gos_zero", loader)).toBe(0);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent callers into a single loader call", async () => {
    let release!: (value: string) => void;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );

    const a = getOrSet("gos_inflight", loader);
    const b = getOrSet("gos_inflight", loader);
    const c = getOrSet("gos_inflight", loader);

    await Promise.resolve(); // let the (deferred) loader start
    release("shared");

    expect(await Promise.all([a, b, c])).toEqual(["shared", "shared", "shared"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves a stale value when the loader fails", async () => {
    set("gos_stale", "old", 1000);
    vi.advanceTimersByTime(1001); // now expired, but still on disk

    const value = await getOrSet("gos_stale", async () => {
      throw new Error("rpc down");
    });

    expect(value).toBe("old");
  });

  it("propagates the error when there is nothing cached to fall back on", async () => {
    await expect(
      getOrSet("gos_hard_fail", async () => {
        throw new Error("rpc down");
      })
    ).rejects.toThrow("rpc down");
  });

  it("clears the in-flight entry so a failed load can be retried", async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("recovered");

    await expect(getOrSet("gos_retry", loader)).rejects.toThrow("boom");
    await expect(getOrSet("gos_retry", loader)).resolves.toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidate cancels in-flight reuse for the key", async () => {
    const loader = vi.fn().mockResolvedValue("v1");
    await getOrSet("gos_inv", loader);
    invalidate("gos_inv");
    await getOrSet("gos_inv", loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

// ── Graceful degradation when the persistent tier is down ─────────────────────

describe("cache – graceful degradation (storage unavailable)", () => {
  it("keeps serving from memory when writes to localStorage throw", () => {
    installFailingLocalStorageMock(["setItem"]);

    expect(() => set("deg_write", "value")).not.toThrow();
    expect(get("deg_write")).toBe("value"); // memory tier still holds it
    expect(store["ip_deg_write"]).toBeUndefined(); // nothing persisted
  });

  it("reports the outage through getCacheHealth", () => {
    installFailingLocalStorageMock(["setItem"]);
    set("deg_health", "value");

    const health = getCacheHealth();
    expect(health.persistent).toBe(false);
    expect(health.reason).toBe("write-failed");
    expect(health.since).toBe(Date.now());
  });

  it("logs the degradation exactly once, not on every write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFailingLocalStorageMock(["setItem"]);

    set("deg_log_1", "a");
    set("deg_log_2", "b");
    set("deg_log_3", "c");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("persistent tier unavailable");
  });

  it("degrades on read failures and returns null so callers refetch", () => {
    installFailingLocalStorageMock(["getItem"]);

    expect(get("deg_read")).toBeNull();
    expect(getCacheHealth().persistent).toBe(false);
    expect(getCacheHealth().reason).toBe("read-failed");
  });

  it("treats corrupt data as a miss, NOT as an outage", () => {
    store["ip_deg_corrupt"] = "not valid json {{{";

    expect(get("deg_corrupt")).toBeNull();
    expect(getCacheHealth().persistent).toBe(true);
  });

  it("falls back to the loader (network) while degraded", async () => {
    installFailingLocalStorageMock(["setItem", "getItem"]);
    const loader = vi.fn().mockResolvedValue("from network");

    expect(await getOrSet("deg_loader", loader)).toBe("from network");
    // Second call is served by the memory tier — degradation must not turn
    // every read into a network call.
    expect(await getOrSet("deg_loader", loader)).toBe("from network");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getCacheHealth().persistent).toBe(false);
  });

  it("getStale still works from memory while degraded", () => {
    installFailingLocalStorageMock(["setItem"]);
    set("deg_stale", "value", 1000);
    vi.advanceTimersByTime(5000);

    expect(getStale("deg_stale")).toBe("value");
  });

  it("invalidation never throws while storage is failing", () => {
    installFailingLocalStorageMock(["setItem", "removeItem"]);
    set("deg_clear", "value");

    expect(() => invalidate("deg_clear")).not.toThrow();
    expect(() => invalidateAll()).not.toThrow();
    expect(get("deg_clear")).toBeNull();
  });

  it("stays degraded during the cool-down, then re-probes and recovers", () => {
    installFailingLocalStorageMock(["setItem"]);
    set("deg_a", "a");
    expect(getCacheHealth().persistent).toBe(false);

    // Storage comes back, but we do not probe on every call.
    installLocalStorageMock();
    set("deg_b", "b");
    expect(store["ip_deg_b"]).toBeUndefined();
    expect(getCacheHealth().persistent).toBe(false);

    // After the cool-down the next access probes and finds storage healthy.
    vi.advanceTimersByTime(60_001);
    set("deg_c", "c");
    expect(store["ip_deg_c"]).toBeDefined();
    expect(getCacheHealth().persistent).toBe(true);
  });

  it("stays degraded when the re-probe also fails", () => {
    installFailingLocalStorageMock(["setItem"]);
    set("deg_x", "x");

    vi.advanceTimersByTime(60_001);
    set("deg_y", "y");

    expect(getCacheHealth().persistent).toBe(false);
    expect(getCacheHealth().reason).toBe("probe-failed");
    expect(get("deg_y")).toBe("y"); // memory tier unaffected
  });
});

// ── SSR safety (last — manipulates window) ────────────────────────────────────

describe("cache – SSR safety (no window)", () => {
  it("get returns null when window is undefined", () => {
    const origWindow = globalThis.window;
    // @ts-expect-error — simulating SSR
    delete globalThis.window;
    expect(get("anything")).toBeNull();
    // Restore
    Object.defineProperty(globalThis, "window", {
      value: origWindow,
      writable: true,
      configurable: true,
    });
  });

  it("set is a no-op when window is undefined", () => {
    const origWindow = globalThis.window;
    // @ts-expect-error — simulating SSR
    delete globalThis.window;
    set("ssr", "data"); // should not throw
    // Restore
    Object.defineProperty(globalThis, "window", {
      value: origWindow,
      writable: true,
      configurable: true,
    });
    installLocalStorageMock();
    // Key should not be stored (set was a no-op)
    expect(store["ip_ssr"]).toBeUndefined();
  });
});
