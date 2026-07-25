import { describe, expect, it, vi } from "vitest";
import {
  decodeReferralRegisteredEvent,
  handleReferralRegisteredEvent,
} from "../handlers/referral_registered.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const ALICE = "GALICE" + "A".repeat(50); // 56 chars
const BOB = "GBOB" + "B".repeat(52); // 56 chars

function sampleEvent(
  data: unknown = { user: ALICE, display_name: "Alice", referrer: BOB },
): DecodedContractEvent {
  return {
    topics: ["referral", "registered"],
    data,
    ledger: 123456,
    txHash: "abc123",
  };
}

describe("referral_registered handler", () => {
  it("decodes object payloads with a referrer", () => {
    expect(decodeReferralRegisteredEvent(sampleEvent())).toEqual({
      user: ALICE,
      display_name: "Alice",
      referrer: BOB,
      welcome_points: 5,
      referrer_points: 5,
    });
  });

  it("decodes object payloads without a referrer", () => {
    expect(decodeReferralRegisteredEvent(sampleEvent({ user: ALICE, display_name: "Alice" }))).toEqual({
      user: ALICE,
      display_name: "Alice",
      referrer: null,
      welcome_points: 5,
      referrer_points: 5,
    });
  });

  it("decodes tuple payloads (user, display_name, referrer)", () => {
    expect(decodeReferralRegisteredEvent(sampleEvent([ALICE, "Alice", BOB]))).toEqual({
      user: ALICE,
      display_name: "Alice",
      referrer: BOB,
      welcome_points: 5,
      referrer_points: 5,
    });
  });

  it("treats blank/missing display name as null", () => {
    expect(decodeReferralRegisteredEvent(sampleEvent([ALICE, "   "]))).toEqual({
      user: ALICE,
      display_name: null,
      referrer: null,
      welcome_points: 5,
      referrer_points: 5,
    });
  });

  it("honours explicit bonus overrides", () => {
    expect(
      decodeReferralRegisteredEvent(
        sampleEvent({ user: ALICE, welcome_bonus_points: 10, referrer: BOB, referrer_bonus_points: 2 }),
      ),
    ).toEqual({
      user: ALICE,
      display_name: null,
      referrer: BOB,
      welcome_points: 10,
      referrer_points: 2,
    });
  });

  it("rejects an invalid user address", () => {
    expect(() => decodeReferralRegisteredEvent(sampleEvent({ user: "invalid" }))).toThrow();
    expect(() => decodeReferralRegisteredEvent(sampleEvent({ user: 123 }))).toThrow();
  });

  it("rejects an invalid referrer address", () => {
    expect(() => decodeReferralRegisteredEvent(sampleEvent({ user: ALICE, referrer: "nope" }))).toThrow();
  });

  it("rejects self-referral", () => {
    expect(() => decodeReferralRegisteredEvent(sampleEvent({ user: ALICE, referrer: ALICE }))).toThrow();
  });

  it("rejects an over-long display name", () => {
    expect(() =>
      decodeReferralRegisteredEvent(sampleEvent({ user: ALICE, display_name: "x".repeat(51) })),
    ).toThrow();
  });

  it("rejects negative bonus points", () => {
    expect(() =>
      decodeReferralRegisteredEvent(sampleEvent({ user: ALICE, welcome_bonus_points: -1 })),
    ).toThrow();
  });

  it("rejects an unexpected topic", () => {
    expect(() =>
      decodeReferralRegisteredEvent({ topics: ["referral", "reward"], data: { user: ALICE } }),
    ).toThrow();
  });

  it("credits registrant and referrer, then invalidates the cache", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

    await expect(handleReferralRegisteredEvent(sampleEvent(), db, redis)).resolves.toEqual({
      user: ALICE,
      display_name: "Alice",
      referrer: BOB,
      welcome_points: 5,
      referrer_points: 5,
    });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO leaderboard"),
      [ALICE, "Alice", 5],
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO leaderboard"),
      [BOB, 5],
    );
    expect(redis.del).toHaveBeenCalledWith("leaderboard:top20");
  });

  it("skips the referrer write when none is supplied", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

    await handleReferralRegisteredEvent(sampleEvent({ user: ALICE, display_name: "Alice" }), db, redis);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO leaderboard"),
      [ALICE, "Alice", 5],
    );
    expect(redis.del).toHaveBeenCalledWith("leaderboard:top20");
  });
});
