/**
 * Integration-style tests for cache invalidation helpers.
 *
 * Uses an in-memory fake Redis (no real Redis required) to assert that each
 * domain helper deletes exactly the expected set of keys and leaves unrelated
 * keys intact.
 *
 * Acceptance criteria from issue #104:
 *   ✓ Invalidation helper exported
 *   ✓ Each relevant handler invalidates the right keys
 *   ✓ Integration test: write → cache cleared
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  invalidate,
  invalidateOnMarketCreated,
  invalidateOnBetPlaced,
  invalidateOnMarketResolved,
  invalidateOnMarketCancelled,
} from "./invalidate.js";
import {
  marketKey,
  marketsAllKey,
  marketsActiveKey,
  leaderboardKey,
  betsKey,
  statsKey,
  resetVersion,
} from "./cacheKeys.js";

// ---------------------------------------------------------------------------
// Fake Redis
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory Redis stub.  Supports get/set/del; del returns the
 * number of keys that were actually present (matching real Redis behaviour).
 */
function createFakeRedis() {
  const store = new Map<string, string>();

  return {
    _store: store,

    /** Seed a key so tests can assert it was removed. */
    seed(key: string, value = "cached") {
      store.set(key, value);
    },

    has(key: string): boolean {
      return store.has(key);
    },

    del: vi.fn((...keys: string[]): Promise<number> => {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return Promise.resolve(count);
    }) as any,
  };
}


type FakeRedis = ReturnType<typeof createFakeRedis>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetVersion();
});

function seedAll(redis: FakeRedis, marketId: number): void {
  redis.seed(marketKey(marketId));
  redis.seed(marketsAllKey());
  redis.seed(marketsActiveKey());
  redis.seed(leaderboardKey());
  redis.seed(betsKey(marketId));
  redis.seed(statsKey()); // unrelated — should never be deleted
}

// ---------------------------------------------------------------------------
// Core primitive: invalidate()
// ---------------------------------------------------------------------------

describe("invalidate()", () => {
  it("is exported from the module", () => {
    expect(typeof invalidate).toBe("function");
  });

  it("deletes a single key", async () => {
    const redis = createFakeRedis();
    redis.seed("some:key");

    const count = await invalidate(redis, "some:key");

    expect(count).toBe(1);
    expect(redis.has("some:key")).toBe(false);
  });

  it("deletes multiple keys in one call", async () => {
    const redis = createFakeRedis();
    redis.seed("key:a");
    redis.seed("key:b");
    redis.seed("key:c");

    const count = await invalidate(redis, "key:a", "key:b", "key:c");

    expect(count).toBe(3);
    expect(redis.has("key:a")).toBe(false);
    expect(redis.has("key:b")).toBe(false);
    expect(redis.has("key:c")).toBe(false);
  });

  it("returns 0 when no keys are provided", async () => {
    const redis = createFakeRedis();

    const count = await invalidate(redis);

    expect(count).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("returns 0 for keys that do not exist", async () => {
    const redis = createFakeRedis();

    const count = await invalidate(redis, "nonexistent:key");

    expect(count).toBe(0);
  });

  it("does not delete unrelated keys", async () => {
    const redis = createFakeRedis();
    redis.seed("keep:this");
    redis.seed("delete:this");

    await invalidate(redis, "delete:this");

    expect(redis.has("keep:this")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invalidateOnMarketCreated — market created → markets:all, markets:active
// ---------------------------------------------------------------------------

describe("invalidateOnMarketCreated()", () => {
  it("clears markets:all and markets:active", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 1);

    await invalidateOnMarketCreated(redis);

    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });

  it("does NOT clear individual market, bets, leaderboard, or stats keys", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 1);

    await invalidateOnMarketCreated(redis);

    expect(redis.has(marketKey(1))).toBe(true);
    expect(redis.has(betsKey(1))).toBe(true);
    expect(redis.has(leaderboardKey())).toBe(true);
    expect(redis.has(statsKey())).toBe(true);
  });

  it("write → cache cleared (integration): market list is gone after created event", async () => {
    const redis = createFakeRedis();

    // Simulate: markets list was cached from a previous read.
    redis.seed(marketsAllKey(), JSON.stringify([{ id: 1 }]));
    redis.seed(marketsActiveKey(), JSON.stringify([{ id: 1 }]));

    // Market created event fires.
    await invalidateOnMarketCreated(redis);

    // Both list caches are cleared.
    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invalidateOnBetPlaced — bet → market:{id}, markets:active
// ---------------------------------------------------------------------------

describe("invalidateOnBetPlaced()", () => {
  it("clears market:{id} and markets:active", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 7);

    await invalidateOnBetPlaced(redis, 7);

    expect(redis.has(marketKey(7))).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });

  it("does NOT clear markets:all, bets, leaderboard, or stats keys", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 7);

    await invalidateOnBetPlaced(redis, 7);

    expect(redis.has(marketsAllKey())).toBe(true);
    expect(redis.has(betsKey(7))).toBe(true);
    expect(redis.has(leaderboardKey())).toBe(true);
    expect(redis.has(statsKey())).toBe(true);
  });

  it("only clears the specific market, not other markets", async () => {
    const redis = createFakeRedis();
    redis.seed(marketKey(5));
    redis.seed(marketKey(6));

    await invalidateOnBetPlaced(redis, 5);

    expect(redis.has(marketKey(5))).toBe(false);
    expect(redis.has(marketKey(6))).toBe(true); // unaffected
  });

  it("accepts string market IDs", async () => {
    const redis = createFakeRedis();
    redis.seed(marketKey("42"));
    redis.seed(marketsActiveKey());

    await invalidateOnBetPlaced(redis, "42");

    expect(redis.has(marketKey("42"))).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });

  it("write → cache cleared (integration): market and active list gone after bet", async () => {
    const redis = createFakeRedis();

    // Simulate: market and active list are cached.
    redis.seed(marketKey(3), JSON.stringify({ id: 3, total_yes: 100 }));
    redis.seed(marketsActiveKey(), JSON.stringify([{ id: 3 }]));

    // Bet placed event fires.
    await invalidateOnBetPlaced(redis, 3);

    expect(redis.has(marketKey(3))).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invalidateOnMarketResolved — resolved → all market caches + leaderboard
// ---------------------------------------------------------------------------

describe("invalidateOnMarketResolved()", () => {
  it("clears market:{id}, markets:all, markets:active, bets:{id}, leaderboard", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 2);

    await invalidateOnMarketResolved(redis, 2);

    expect(redis.has(marketKey(2))).toBe(false);
    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
    expect(redis.has(betsKey(2))).toBe(false);
    expect(redis.has(leaderboardKey())).toBe(false);
  });

  it("does NOT clear the unrelated stats key", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 2);

    await invalidateOnMarketResolved(redis, 2);

    expect(redis.has(statsKey())).toBe(true);
  });

  it("only clears the bets key for the resolved market", async () => {
    const redis = createFakeRedis();
    redis.seed(betsKey(2));
    redis.seed(betsKey(3)); // different market

    await invalidateOnMarketResolved(redis, 2);

    expect(redis.has(betsKey(2))).toBe(false);
    expect(redis.has(betsKey(3))).toBe(true);
  });

  it("write → cache cleared (integration): full invalidation after resolution", async () => {
    const redis = createFakeRedis();

    // Simulate caches written by the API server before resolution.
    redis.seed(marketKey(10), JSON.stringify({ id: 10, resolved: false }));
    redis.seed(marketsAllKey(), JSON.stringify([{ id: 10 }]));
    redis.seed(marketsActiveKey(), JSON.stringify([{ id: 10 }]));
    redis.seed(betsKey(10), JSON.stringify([{ bettor: "GXYZ", amount: 50 }]));
    redis.seed(leaderboardKey(), JSON.stringify([{ address: "GXYZ", points: 100 }]));

    // Market resolved event fires.
    await invalidateOnMarketResolved(redis, 10);

    // All stale caches are cleared.
    expect(redis.has(marketKey(10))).toBe(false);
    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
    expect(redis.has(betsKey(10))).toBe(false);
    expect(redis.has(leaderboardKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invalidateOnMarketCancelled — cancelled → market:{id}, markets:all, markets:active
// ---------------------------------------------------------------------------

describe("invalidateOnMarketCancelled()", () => {
  it("clears market:{id}, markets:all, and markets:active", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 4);

    await invalidateOnMarketCancelled(redis, 4);

    expect(redis.has(marketKey(4))).toBe(false);
    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });

  it("does NOT clear bets, leaderboard, or stats keys", async () => {
    const redis = createFakeRedis();
    seedAll(redis, 4);

    await invalidateOnMarketCancelled(redis, 4);

    expect(redis.has(betsKey(4))).toBe(true);
    expect(redis.has(leaderboardKey())).toBe(true);
    expect(redis.has(statsKey())).toBe(true);
  });

  it("write → cache cleared (integration): market cleared after cancellation", async () => {
    const redis = createFakeRedis();

    redis.seed(marketKey(8), JSON.stringify({ id: 8, cancelled: false }));
    redis.seed(marketsAllKey(), JSON.stringify([{ id: 8 }]));
    redis.seed(marketsActiveKey(), JSON.stringify([{ id: 8 }]));

    await invalidateOnMarketCancelled(redis, 8);

    expect(redis.has(marketKey(8))).toBe(false);
    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.has(marketsActiveKey())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Versioning: keys respect the current version prefix
// ---------------------------------------------------------------------------

describe("versioned keys", () => {
  it("invalidation uses the current version prefix", async () => {
    const redis = createFakeRedis();

    // v1 key is seeded — should be deleted.
    redis.seed(marketsAllKey()); // "ipredict:v1:markets:all"

    await invalidateOnMarketCreated(redis);

    expect(redis.has(marketsAllKey())).toBe(false);
    expect(redis.del).toHaveBeenCalledWith(
      marketsAllKey(),
      marketsActiveKey(),
    );
  });
});
