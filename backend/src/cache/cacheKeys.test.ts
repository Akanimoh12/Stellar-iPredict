import { describe, it, expect, beforeEach } from "vitest";
import {
  CACHE_NAMESPACE,
  getVersion,
  bumpVersion,
  resetVersion,
  cacheKey,
  cacheKeyPattern,
  marketKey,
  marketsAllKey,
  marketsActiveKey,
  leaderboardKey,
  statsKey,
  betsKey,
} from "../cache/cacheKeys.js";

beforeEach(() => {
  resetVersion();
});

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

describe("cacheKey", () => {
  it("joins namespace, version, entity, and parts with colons", () => {
    expect(cacheKey("market", 42)).toBe("ipredict:v1:market:42");
  });

  it("handles string parts", () => {
    expect(cacheKey("markets", "active")).toBe("ipredict:v1:markets:active");
  });

  it("handles multiple parts", () => {
    expect(cacheKey("user", "abc", "bets")).toBe("ipredict:v1:user:abc:bets");
  });

  it("works with zero extra parts", () => {
    expect(cacheKey("stats")).toBe("ipredict:v1:stats");
  });
});

describe("cacheKeyPattern", () => {
  it("returns a glob matching all keys for an entity", () => {
    expect(cacheKeyPattern("market")).toBe("ipredict:v1:market:*");
  });
});

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

describe("version management", () => {
  it("starts at v1", () => {
    expect(getVersion()).toBe("v1");
  });

  it("bumpVersion increments and returns the new version", () => {
    const v = bumpVersion();
    expect(v).toBe("v2");
    expect(getVersion()).toBe("v2");
  });

  it("bumping changes all keys produced afterward", () => {
    const before = cacheKey("market", 1);
    bumpVersion();
    const after = cacheKey("market", 1);

    expect(before).toBe("ipredict:v1:market:1");
    expect(after).toBe("ipredict:v2:market:1");
    expect(before).not.toBe(after);
  });

  it("patterns also reflect the new version after a bump", () => {
    bumpVersion();
    expect(cacheKeyPattern("market")).toBe("ipredict:v2:market:*");
  });

  it("multiple bumps are cumulative", () => {
    bumpVersion(); // v2
    bumpVersion(); // v3
    expect(getVersion()).toBe("v3");
    expect(cacheKey("x")).toBe("ipredict:v3:x");
  });
});

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

describe("namespace", () => {
  it("is 'ipredict'", () => {
    expect(CACHE_NAMESPACE).toBe("ipredict");
  });

  it("appears at the start of every key", () => {
    expect(cacheKey("any", "thing").startsWith("ipredict:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Typed key builders
// ---------------------------------------------------------------------------

describe("typed key builders", () => {
  it("marketKey(42) → ipredict:v1:market:42", () => {
    expect(marketKey(42)).toBe("ipredict:v1:market:42");
  });

  it("marketKey accepts string IDs", () => {
    expect(marketKey("7")).toBe("ipredict:v1:market:7");
  });

  it("marketsAllKey() → ipredict:v1:markets:all", () => {
    expect(marketsAllKey()).toBe("ipredict:v1:markets:all");
  });

  it("marketsActiveKey() → ipredict:v1:markets:active", () => {
    expect(marketsActiveKey()).toBe("ipredict:v1:markets:active");
  });

  it("leaderboardKey() → ipredict:v1:leaderboard:top20", () => {
    expect(leaderboardKey()).toBe("ipredict:v1:leaderboard:top20");
  });

  it("statsKey() → ipredict:v1:stats:global", () => {
    expect(statsKey()).toBe("ipredict:v1:stats:global");
  });

  it("betsKey(3) → ipredict:v1:bets:3", () => {
    expect(betsKey(3)).toBe("ipredict:v1:bets:3");
  });

  it("typed builders also respect version bumps", () => {
    bumpVersion();
    expect(marketKey(1)).toBe("ipredict:v2:market:1");
    expect(leaderboardKey()).toBe("ipredict:v2:leaderboard:top20");
  });
});
