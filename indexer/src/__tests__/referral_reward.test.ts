import { describe, expect, it, vi } from "vitest";
import { decodeReferralRewardEvent, handleReferralRewardEvent } from "../handlers/referral_reward.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const ALICE = "GALICE" + "A".repeat(50); // 56 chars

function sampleEvent(data: unknown = { referrer: ALICE, points: 3 }): DecodedContractEvent {
  return {
    topics: ["referral", "reward"],
    data,
    ledger: 123456,
    txHash: "abc123",
  };
}

describe("referral_reward handler", () => {
  it("decodes and validates object payloads with points", () => {
    expect(decodeReferralRewardEvent(sampleEvent({ referrer: ALICE, points: 5 }))).toEqual({
      referrer: ALICE,
      points: 5,
    });
  });

  it("decodes and validates object payloads without points (default to 3)", () => {
    expect(decodeReferralRewardEvent(sampleEvent({ referrer: ALICE }))).toEqual({
      referrer: ALICE,
      points: 3,
    });
  });

  it("decodes and validates tuple payloads with points", () => {
    expect(decodeReferralRewardEvent(sampleEvent([ALICE, 10]))).toEqual({
      referrer: ALICE,
      points: 10,
    });
  });

  it("decodes and validates tuple payloads without points (default to 3)", () => {
    expect(decodeReferralRewardEvent(sampleEvent([ALICE]))).toEqual({
      referrer: ALICE,
      points: 3,
    });
  });

  it("rejects invalid referrer address", () => {
    expect(() => decodeReferralRewardEvent(sampleEvent({ referrer: "invalid" }))).toThrow();
    expect(() => decodeReferralRewardEvent(sampleEvent({ referrer: 123 }))).toThrow();
  });

  it("rejects invalid points", () => {
    expect(() => decodeReferralRewardEvent(sampleEvent({ referrer: ALICE, points: -1 }))).toThrow();
    expect(() => decodeReferralRewardEvent(sampleEvent({ referrer: ALICE, points: "abc" }))).toThrow();
  });

  it("updates leaderboard idempotently and invalidates cache", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

    await expect(handleReferralRewardEvent(sampleEvent(), db, redis)).resolves.toEqual({
      referrer: ALICE,
      points: 3,
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO leaderboard"),
      [ALICE, 3]
    );
    expect(redis.del).toHaveBeenCalledWith("leaderboard:top20");
  });
});
