import { describe, expect, it } from "vitest";
import { ProviderRateLimiter } from "./rateLimiter.js";

describe("ProviderRateLimiter", () => {
  it("enforces a quota independently for each provider", () => {
    const limiter = new ProviderRateLimiter({
      defaultLimit: 2,
      defaultWindowMs: 1_000,
    });

    expect(limiter.tryAcquire("binance")).toBe(true);
    expect(limiter.tryAcquire("binance")).toBe(true);
    expect(limiter.tryAcquire("binance")).toBe(false);
    expect(limiter.tryAcquire("coinmarketcap")).toBe(true);
  });

  it("uses provider-specific limits", () => {
    const limiter = new ProviderRateLimiter({
      defaultLimit: 5,
      defaultWindowMs: 1_000,
      providers: {
        binance: { limit: 1, windowMs: 1_000 },
      },
    });

    expect(limiter.tryAcquire("binance")).toBe(true);
    expect(limiter.tryAcquire("binance")).toBe(false);
    expect(limiter.tryAcquire("other")).toBe(true);
    expect(limiter.tryAcquire("other")).toBe(true);
  });

  it("waits for the oldest reservation before admitting another request", async () => {
    let now = 0;
    const waits: number[] = [];
    const originalDateNow = Date.now;
    Date.now = () => now;

    try {
      const limiter = new ProviderRateLimiter({
        defaultLimit: 1,
        defaultWindowMs: 100,
        sleep: async (durationMs) => {
          waits.push(durationMs);
          now += durationMs;
        },
      });

      expect(limiter.tryAcquire("binance")).toBe(true);
      await limiter.acquire("binance");

      expect(waits).toEqual([100]);
      now += 100;
      expect(limiter.tryAcquire("binance")).toBe(true);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("shares reservations when multiple adapters use the same limiter", () => {
    const limiter = new ProviderRateLimiter({
      defaultLimit: 1,
      defaultWindowMs: 1_000,
    });

    expect(limiter.tryAcquire("binance")).toBe(true);
    expect(limiter.tryAcquire("binance")).toBe(false);
  });
});
