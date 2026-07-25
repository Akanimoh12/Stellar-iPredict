import { describe, expect, it, vi } from "vitest";
import { decodeClaim, handleClaim, REWARD_CLAIMED_TOPIC } from "../claim.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const MARKET_ID = 1;

function createEvent(data: unknown): DecodedEvent {
  return {
    ledger: 100n,
    txHash: "0".repeat(64),
    topics: [REWARD_CLAIMED_TOPIC, MARKET_ID, USER],
    data,
  };
}

function createContext(): HandlerContext {
  return {
    db: { query: vi.fn().mockResolvedValue(undefined) },
    redis: { del: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
  };
}

describe("decodeClaim", () => {
  it("decodes a reward_claimed payload from data fields", () => {
    expect(decodeClaim(createEvent({ market_id: MARKET_ID, user: USER, payout_xlm: 500000000 }))).toEqual({
      market_id: MARKET_ID,
      user: USER,
      payout_xlm: 500000000,
    });
  });

  it("falls back to topics for market_id and user when data is absent", () => {
    expect(decodeClaim(createEvent(null))).toEqual({
      market_id: MARKET_ID,
      user: USER,
    });
  });

  it("falls back to topics for user when data uses bettor alias", () => {
    expect(decodeClaim(createEvent({ market_id: MARKET_ID, bettor: USER }))).toEqual({
      market_id: MARKET_ID,
      user: USER,
    });
  });

  it("rejects invalid payloads", () => {
    expect(() => decodeClaim(createEvent({ market_id: -1, user: USER }))).toThrow(
      "non-negative integer",
    );
    expect(() => decodeClaim(createEvent({ market_id: MARKET_ID, user: "bad" }))).toThrow(
      "valid Stellar public key",
    );
  });
});

describe("handleClaim", () => {
  it("marks bet as claimed, records the raw event, and invalidates affected cache keys", async () => {
    const context = createContext();
    const event = createEvent({ market_id: MARKET_ID, user: USER, payout_xlm: 500000000 });

    await handleClaim(event, context);

    expect(context.db.query).toHaveBeenCalledTimes(2);
    expect(context.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE bets"),
      [MARKET_ID, USER],
    );
    expect(context.db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO events"),
      [event.ledger, event.txHash, REWARD_CLAIMED_TOPIC, MARKET_ID, USER, { market_id: MARKET_ID, user: USER, payout_xlm: 500000000 }],
    );
    expect(context.redis?.del).toHaveBeenCalledWith(`bets:${MARKET_ID}`, "leaderboard:top20");
  });
});
