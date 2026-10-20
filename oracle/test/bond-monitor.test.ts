import { describe, expect, it, vi } from "vitest";
import {
  assertBondSpendWithinHourlyLimit,
  BondSpendLimitExceededError,
  checkBondSpendFromDb,
  type BondSpendLimitOptions,
} from "../src/aggregator/bond-monitor.js";
import type { QueryablePool } from "../src/aggregator/tally.js";

const options: BondSpendLimitOptions = {
  hourlySpendLimit: 1_000n,
  alertThresholdPercent: 80,
};
const NOW = new Date("2026-10-18T12:00:00.000Z");

function poolWithSpend(spend: string): QueryablePool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ hourly_spend: spend }] }),
  };
}

describe("rolling bond spend limit", () => {
  it("reports the rolling-hour spend and threshold status", async () => {
    const pool = poolWithSpend("800");

    await expect(checkBondSpendFromDb(pool, options, NOW)).resolves.toEqual({
      hourlySpend: 800n,
      hourlySpendLimit: 1_000n,
      alertThresholdPercent: 80,
      limitApproached: true,
      limitExceeded: false,
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("COALESCE(challenged_at, created_at)"), [
      new Date(NOW.getTime() - 60 * 60 * 1_000),
      NOW,
    ]);
  });

  it("allows a spend that stays within the hourly ceiling", async () => {
    await expect(
      assertBondSpendWithinHourlyLimit(poolWithSpend("700"), 300n, options, NOW),
    ).resolves.toBeUndefined();
  });

  it("blocks a spend that would exceed the hourly ceiling", async () => {
    await expect(
      assertBondSpendWithinHourlyLimit(poolWithSpend("800"), 201n, options, NOW),
    ).rejects.toBeInstanceOf(BondSpendLimitExceededError);
  });

  it("rejects invalid operator limit and threshold settings", async () => {
    await expect(
      checkBondSpendFromDb(poolWithSpend("0"), { hourlySpendLimit: 0n, alertThresholdPercent: 80 }),
    ).rejects.toThrow(/hourlySpendLimit/);
    await expect(
      checkBondSpendFromDb(poolWithSpend("0"), { hourlySpendLimit: 1n, alertThresholdPercent: 101 }),
    ).rejects.toThrow(/alertThresholdPercent/);
  });
});
