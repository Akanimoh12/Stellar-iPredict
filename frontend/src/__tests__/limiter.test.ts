import { describe, it, expect } from "vitest";
import { createRateLimiter } from "@/services/limiter";

// The limiter takes an explicit `now`, so these cases drive time directly
// instead of relying on fake timers.
const T0 = 1_800_000_000_000;

describe("rateLimiter – budget", () => {
  it("allows exactly `limit` requests inside a window", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });

    expect(limiter.check("ip", T0).allowed).toBe(true);
    expect(limiter.check("ip", T0 + 1).allowed).toBe(true);
    expect(limiter.check("ip", T0 + 2).allowed).toBe(true);
    expect(limiter.check("ip", T0 + 3).allowed).toBe(false);
  });

  it("counts down `remaining` and floors it at zero", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });

    expect(limiter.check("ip", T0).remaining).toBe(1);
    expect(limiter.check("ip", T0).remaining).toBe(0);
    expect(limiter.check("ip", T0).remaining).toBe(0); // blocked, never negative
  });

  it("reports the limit and when the window resets", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 10_000 });

    const first = limiter.check("ip", T0);
    expect(first.limit).toBe(1);
    expect(first.resetAt).toBe(T0 + 10_000);

    const blocked = limiter.check("ip", T0 + 4_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(6_000);
  });

  it("starts a fresh window once the old one has elapsed", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.check("ip", T0).allowed).toBe(true);
    expect(limiter.check("ip", T0 + 999).allowed).toBe(false);
    expect(limiter.check("ip", T0 + 1000).allowed).toBe(true);
    expect(limiter.check("ip", T0 + 1000).remaining).toBe(0);
  });

  it("tracks each key independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.check("10.0.0.1", T0).allowed).toBe(true);
    expect(limiter.check("10.0.0.1", T0).allowed).toBe(false);
    // A noisy client must not consume anyone else's budget.
    expect(limiter.check("10.0.0.2", T0).allowed).toBe(true);
  });
});

describe("rateLimiter – peek", () => {
  it("does not consume budget", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });

    expect(limiter.peek("ip", T0).remaining).toBe(2);
    expect(limiter.peek("ip", T0).remaining).toBe(2);
    expect(limiter.check("ip", T0).remaining).toBe(1);
    expect(limiter.peek("ip", T0).remaining).toBe(1);
  });

  it("reports a full budget for an unknown or expired key", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000 });
    limiter.check("ip", T0);

    expect(limiter.peek("unknown", T0).allowed).toBe(true);
    expect(limiter.peek("ip", T0 + 5000).remaining).toBe(5);
  });
});

describe("rateLimiter – housekeeping", () => {
  it("resets a single key without touching the others", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.check("a", T0);
    limiter.check("b", T0);

    limiter.reset("a");

    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("b", T0).allowed).toBe(false);
  });

  it("resets every key when called with no argument", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.check("a", T0);
    limiter.check("b", T0);

    limiter.reset();

    expect(limiter.size()).toBe(0);
    expect(limiter.check("a", T0).allowed).toBe(true);
  });

  it("sweeps expired windows so unique keys cannot grow unbounded", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 10 });

    for (let i = 0; i < 10; i++) limiter.check(`ip-${i}`, T0);
    expect(limiter.size()).toBe(10);

    // A new key past the cap, after the old windows expired → old keys dropped.
    limiter.check("late", T0 + 2000);
    expect(limiter.size()).toBe(1);
  });

  it("keeps live windows when sweeping", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 2 });
    limiter.check("a", T0);
    limiter.check("b", T0);

    limiter.check("c", T0 + 500); // sweep runs, but nothing has expired yet
    expect(limiter.check("a", T0 + 500).remaining).toBe(3); // "a" survived
  });

  it("rejects nonsensical configuration", () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1000 })).toThrow();
    expect(() => createRateLimiter({ limit: 5, windowMs: 0 })).toThrow();
  });
});
