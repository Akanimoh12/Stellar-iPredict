import { describe, expect, it } from "vitest";
import { detectStuckMarket, detectStuckMarkets } from "../src/aggregator/stuck-market.js";

describe("detectStuckMarket", () => {
  it("flags a market stuck more than 6 hours past expiry", () => {
    const endTime = 1_000_000;
    const now = endTime + 7 * 3_600; // 7 hours later
    const alert = detectStuckMarket("42", endTime, now, 6);
    expect(alert.stuck).toBe(true);
    expect(alert.hoursPastExpiry).toBeCloseTo(7);
  });

  it("does not flag a market within the allowed window", () => {
    const endTime = 1_000_000;
    const now = endTime + 5 * 3_600; // 5 hours later
    const alert = detectStuckMarket("42", endTime, now, 6);
    expect(alert.stuck).toBe(false);
    expect(alert.hoursPastExpiry).toBeCloseTo(5);
  });

  it("flags at exactly the threshold boundary", () => {
    const endTime = 1_000_000;
    const now = endTime + 6 * 3_600; // exactly 6 hours
    const alert = detectStuckMarket("42", endTime, now, 6);
    expect(alert.stuck).toBe(true);
  });

  it("reports zero hours when market has not yet expired", () => {
    const endTime = 1_000_000;
    const now = endTime - 1_000; // before expiry
    const alert = detectStuckMarket("42", endTime, now, 6);
    expect(alert.stuck).toBe(false);
    expect(alert.hoursPastExpiry).toBe(0);
  });

  it("rejects non-positive maxHours", () => {
    expect(() => detectStuckMarket("42", 0, 0, 0)).toThrow("positive number");
    expect(() => detectStuckMarket("42", 0, 0, -1)).toThrow("positive number");
  });
});

describe("detectStuckMarkets", () => {
  it("returns alerts only for stuck markets", () => {
    const now = 1_100_000;
    const markets = [
      { id: "1", endTime: now - 7 * 3_600, cancelled: false }, // stuck
      { id: "2", endTime: now - 2 * 3_600, cancelled: false }, // not stuck
      { id: "3", endTime: now - 8 * 3_600, cancelled: false }, // stuck
    ];
    const alerts = detectStuckMarkets(markets, now, 6);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.marketId)).toEqual(["1", "3"]);
  });

  it("excludes cancelled markets", () => {
    const now = 1_100_000;
    const markets = [
      { id: "1", endTime: now - 7 * 3_600, cancelled: true },
    ];
    const alerts = detectStuckMarkets(markets, now, 6);
    expect(alerts).toHaveLength(0);
  });

  it("returns an empty array when no markets are stuck", () => {
    const now = 1_100_000;
    const markets = [
      { id: "1", endTime: now - 1 * 3_600, cancelled: false },
    ];
    const alerts = detectStuckMarkets(markets, now, 6);
    expect(alerts).toHaveLength(0);
  });
});
