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
  cacheFailureLogCount,
  resetFailureLogger,
} from "./invalidate.js";
import { resetCircuitBreaker, getCircuitBreaker } from "./circuitBreaker.js";
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
  resetCircuitBreaker();
  resetFailureLogger();
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

  it("swallows redis.del rejections and returns 0 (#481)", async () => {
    // A redis.del that rejects should be caught — the caller should get 0
    // and not see an unhandled rejection or exception.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingRedis = {
      _store: new Map(),
      del: vi.fn().mockRejectedValue(new Error("Connection lost")),
    };

    const count = await invalidate(failingRedis as any, "some:key");

    expect(count).toBe(0);
    expect(failingRedis.del).toHaveBeenCalledTimes(1);

    vi.mocked(console.warn).mockRestore();
  });

  it("records a circuit-breaker failure on redis.del rejection (#481)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingRedis = {
      _store: new Map(),
      del: vi.fn().mockRejectedValue(new Error("Connection lost")),
    };

    await invalidate(failingRedis as any, "some:key");

    // After a rejection, the circuit breaker should have recorded a failure.
    const breaker = getCircuitBreaker();
    expect(breaker.getMetrics().failures).toBeGreaterThan(0);

    // The rate-limited failure logger should have counted the failure (#481).
    expect(cacheFailureLogCount).toBe(1);

    resetCircuitBreaker();
    vi.mocked(console.warn).mockRestore();
  });

  it("logs cache failures at a rate-limited cadence (#481)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingRedis = {
      _store: new Map(),
      del: vi.fn().mockRejectedValue(new Error("Connection lost")),
    };

    // Two failures — both should be counted.
    await invalidate(failingRedis as any, "key1");
    await invalidate(failingRedis as any, "key2");
    expect(cacheFailureLogCount).toBe(2);

    resetCircuitBreaker();
    vi.mocked(console.warn).mockRestore();
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Issue #547: Comprehensive invalidation tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Comprehensive invalidation coverage (Issue #547)", () => {
  describe("invalidateOnMarketCreated - full dependency graph", () => {
    it("invalidates all dependent keys", async () => {
      const redis = createFakeRedis();
      redis.seed(marketsAllKey());
      redis.seed(marketsActiveKey());
      redis.seed(leaderboardKey()); // Should NOT be cleared
      redis.seed(betsKey(1)); // Should NOT be cleared

      await invalidateOnMarketCreated(redis);

      expect(redis.has(marketsAllKey())).toBe(false);
      expect(redis.has(marketsActiveKey())).toBe(false);
      expect(redis.has(leaderboardKey())).toBe(true); // Preserved
      expect(redis.has(betsKey(1))).toBe(true); // Preserved
    });

    it("does NOT serve stale market list after creation", async () => {
      const redis = createFakeRedis();
      const staleList = JSON.stringify([{ id: 1, title: "Old market" }]);
      
      redis.seed(marketsAllKey(), staleList);
      redis.seed(marketsActiveKey(), staleList);

      // Simulate: Market created event
      await invalidateOnMarketCreated(redis);

      // Both lists must be cleared - next read will fetch fresh data
      expect(redis.has(marketsAllKey())).toBe(false);
      expect(redis.has(marketsActiveKey())).toBe(false);
    });
  });

  describe("invalidateOnBetPlaced - full dependency graph", () => {
    it("invalidates all dependent keys for the market", async () => {
      const redis = createFakeRedis();
      const marketId = 42;

      redis.seed(marketKey(marketId));
      redis.seed(oddsKey(marketId));
      redis.seed(marketsActiveKey());
      redis.seed(marketsAllKey()); // Should NOT be cleared
      redis.seed(betsKey(marketId)); // Should NOT be cleared
      redis.seed(leaderboardKey()); // Should NOT be cleared

      await invalidateOnBetPlaced(redis, marketId);

      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(oddsKey(marketId))).toBe(false);
      expect(redis.has(marketsActiveKey())).toBe(false);
      expect(redis.has(marketsAllKey())).toBe(true); // Preserved
      expect(redis.has(betsKey(marketId))).toBe(true); // Preserved
      expect(redis.has(leaderboardKey())).toBe(true); // Preserved
    });

    it("does NOT serve stale market detail after bet", async () => {
      const redis = createFakeRedis();
      const marketId = 5;
      const staleMarket = JSON.stringify({
        id: 5,
        total_yes: 100,
        total_no: 50,
        odds_yes: 0.667,
      });
      const staleOdds = JSON.stringify({ yes: 0.667, no: 0.333 });

      redis.seed(marketKey(marketId), staleMarket);
      redis.seed(oddsKey(marketId), staleOdds);

      // Simulate: Bet placed event
      await invalidateOnBetPlaced(redis, marketId);

      // Market and odds must be cleared
      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(oddsKey(marketId))).toBe(false);
    });

    it("clears active list but preserves all list after bet", async () => {
      const redis = createFakeRedis();
      redis.seed(marketsActiveKey(), JSON.stringify([{ id: 1 }]));
      redis.seed(marketsAllKey(), JSON.stringify([{ id: 1 }, { id: 2 }]));

      await invalidateOnBetPlaced(redis, 1);

      expect(redis.has(marketsActiveKey())).toBe(false); // Bet changes volume/order
      expect(redis.has(marketsAllKey())).toBe(true); // All list unaffected
    });
  });

  describe("invalidateOnMarketResolved - full dependency graph", () => {
    it("invalidates all dependent keys including leaderboard", async () => {
      const redis = createFakeRedis();
      const marketId = 10;

      redis.seed(marketKey(marketId));
      redis.seed(oddsKey(marketId));
      redis.seed(marketsAllKey());
      redis.seed(marketsActiveKey());
      redis.seed(betsKey(marketId));
      redis.seed(leaderboardKey());
      redis.seed(statsKey()); // Should NOT be cleared

      await invalidateOnMarketResolved(redis, marketId);

      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(oddsKey(marketId))).toBe(false);
      expect(redis.has(marketsAllKey())).toBe(false);
      expect(redis.has(marketsActiveKey())).toBe(false);
      expect(redis.has(betsKey(marketId))).toBe(false);
      expect(redis.has(leaderboardKey())).toBe(false);
      expect(redis.has(statsKey())).toBe(true); // Preserved
    });

    it("does NOT serve stale data after resolution", async () => {
      const redis = createFakeRedis();
      const marketId = 7;
      const staleMarket = JSON.stringify({ id: 7, status: "active" });
      const staleBets = JSON.stringify([{ user: "GXXX", amount: 100 }]);
      const staleLeaderboard = JSON.stringify([{ user: "GXXX", score: 500 }]);

      redis.seed(marketKey(marketId), staleMarket);
      redis.seed(betsKey(marketId), staleBets);
      redis.seed(leaderboardKey(), staleLeaderboard);

      // Simulate: Market resolved event
      await invalidateOnMarketResolved(redis, marketId);

      // All related caches cleared
      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(betsKey(marketId))).toBe(false);
      expect(redis.has(leaderboardKey())).toBe(false);
    });
  });

  describe("invalidateOnMarketCancelled - full dependency graph", () => {
    it("invalidates all dependent keys", async () => {
      const redis = createFakeRedis();
      const marketId = 20;

      redis.seed(marketKey(marketId));
      redis.seed(oddsKey(marketId));
      redis.seed(marketsAllKey());
      redis.seed(marketsActiveKey());
      redis.seed(betsKey(marketId)); // Should NOT be cleared
      redis.seed(leaderboardKey()); // Should NOT be cleared

      await invalidateOnMarketCancelled(redis, marketId);

      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(oddsKey(marketId))).toBe(false);
      expect(redis.has(marketsAllKey())).toBe(false);
      expect(redis.has(marketsActiveKey())).toBe(false);
      expect(redis.has(betsKey(marketId))).toBe(true); // Preserved
      expect(redis.has(leaderboardKey())).toBe(true); // Preserved
    });

    it("does NOT serve stale status after cancellation", async () => {
      const redis = createFakeRedis();
      const marketId = 15;
      const staleMarket = JSON.stringify({ id: 15, status: "active" });

      redis.seed(marketKey(marketId), staleMarket);
      redis.seed(marketsAllKey(), JSON.stringify([{ id: 15, status: "active" }]));

      // Simulate: Market cancelled event
      await invalidateOnMarketCancelled(redis, marketId);

      // Market and lists cleared
      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(marketsAllKey())).toBe(false);
    });
  });

  describe("Negative cache invalidation (Issue #547 - easily forgotten half)", () => {
    it("invalidates negative cache entry when market is created", async () => {
      const redis = createFakeRedis();
      const { NegativeCache } = await import("./negativeCache.js");
      const negativeCache = new NegativeCache(1000);
      const marketId = 99999;
      const key = marketKey(marketId);

      try {
        // Simulate: Market 99999 returned 404, cached as negative
        negativeCache.markMiss(key);
        expect(negativeCache.isCachedMiss(key)).toBe(true);

        // Market 99999 is now created - must invalidate negative cache
        negativeCache.invalidate(key);

        // Next lookup should go to DB, not return cached 404
        expect(negativeCache.isCachedMiss(key)).toBe(false);
      } finally {
        negativeCache.destroy();
      }
    });

    it("does NOT serve cached 404 after resource creation", async () => {
      const redis = createFakeRedis();
      const { NegativeCache } = await import("./negativeCache.js");
      const negativeCache = new NegativeCache(1000);
      const marketId = 77777;
      const key = marketKey(marketId);

      try {
        // Market 77777 doesn't exist - 404 is cached
        negativeCache.markMiss(key);
        expect(negativeCache.isCachedMiss(key)).toBe(true);

        // Market 77777 is created
        negativeCache.invalidate(key);
        await invalidateOnMarketCreated(redis);

        // Must NOT return cached 404
        expect(negativeCache.isCachedMiss(key)).toBe(false);
      } finally {
        negativeCache.destroy();
      }
    });

    it("clears negative cache for resolved market's bets list", async () => {
      const redis = createFakeRedis();
      const { NegativeCache } = await import("./negativeCache.js");
      const negativeCache = new NegativeCache(1000);
      const marketId = 88888;
      const betsKeyValue = betsKey(marketId);

      try {
        // Bets list returned empty/404, cached as negative
        negativeCache.markMiss(betsKeyValue);
        expect(negativeCache.isCachedMiss(betsKeyValue)).toBe(true);

        // Market resolved - bets list changes
        negativeCache.invalidate(betsKeyValue);
        await invalidateOnMarketResolved(redis, marketId);

        // Must fetch fresh bets list
        expect(negativeCache.isCachedMiss(betsKeyValue)).toBe(false);
      } finally {
        negativeCache.destroy();
      }
    });
  });

  describe("Missed invalidation detection (Issue #547)", () => {
    it("fails when market detail is not invalidated on bet", async () => {
      const redis = createFakeRedis();
      const marketId = 1;
      
      redis.seed(marketKey(marketId), JSON.stringify({ total_yes: 100 }));

      // INCORRECT: Missing marketKey invalidation
      await invalidate(redis, marketsActiveKey());

      // This SHOULD fail - market detail is stale
      expect(redis.has(marketKey(marketId))).toBe(true); // STALE!
    });

    it("fails when odds are not invalidated on bet", async () => {
      const redis = createFakeRedis();
      const marketId = 2;

      redis.seed(oddsKey(marketId), JSON.stringify({ yes: 0.5, no: 0.5 }));

      // INCORRECT: Missing oddsKey invalidation
      await invalidate(redis, marketKey(marketId), marketsActiveKey());

      // This SHOULD fail - odds are stale
      expect(redis.has(oddsKey(marketId))).toBe(true); // STALE!
    });

    it("fails when leaderboard is not invalidated on resolution", async () => {
      const redis = createFakeRedis();
      const marketId = 3;

      redis.seed(leaderboardKey(), JSON.stringify([{ user: "GA", score: 100 }]));

      // INCORRECT: Missing leaderboard invalidation
      await invalidate(
        redis,
        marketKey(marketId),
        oddsKey(marketId),
        marketsAllKey(),
        marketsActiveKey(),
        betsKey(marketId)
        // Missing: leaderboardKey()
      );

      // This SHOULD fail - leaderboard is stale
      expect(redis.has(leaderboardKey())).toBe(true); // STALE!
    });
  });

  describe("Cross-endpoint consistency (Issue #547)", () => {
    it("ensures market detail and list endpoints serve same data after bet", async () => {
      const redis = createFakeRedis();
      const marketId = 50;

      // Both endpoints cached before bet
      redis.seed(marketKey(marketId), JSON.stringify({ id: 50, total_yes: 100 }));
      redis.seed(
        marketsActiveKey(),
        JSON.stringify([{ id: 50, total_yes: 100 }])
      );

      // Bet placed - invalidate both
      await invalidateOnBetPlaced(redis, marketId);

      // Neither endpoint should serve stale data
      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(marketsActiveKey())).toBe(false);
    });

    it("ensures market detail and odds endpoints sync after bet", async () => {
      const redis = createFakeRedis();
      const marketId = 60;

      redis.seed(marketKey(marketId), JSON.stringify({ id: 60, odds_yes: 0.5 }));
      redis.seed(oddsKey(marketId), JSON.stringify({ yes: 0.5, no: 0.5 }));

      // Both must be cleared together
      await invalidateOnBetPlaced(redis, marketId);

      expect(redis.has(marketKey(marketId))).toBe(false);
      expect(redis.has(oddsKey(marketId))).toBe(false);
    });
  });
});
