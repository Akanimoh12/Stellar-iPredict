import { describe, expect, it, vi } from "vitest";
import { decodeRewardPoints, handleRewardPoints, REWARD_POINTS_TOPIC } from "../reward_points.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const POINTS = 30;

function createEvent(data: unknown): DecodedEvent {
  return {
    ledger: 100n,
    txHash: "0".repeat(64),
    topics: [REWARD_POINTS_TOPIC, USER, POINTS],
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

describe("decodeRewardPoints", () => {
  it("decodes a reward_points payload from data fields", () => {
    expect(decodeRewardPoints(createEvent({ user: USER, points: POINTS, is_winner: true }))).toEqual({
      user: USER,
      points: POINTS,
      is_winner: true,
    });
  });

  it("decodes a reward_points payload with is_winner false", () => {
    expect(decodeRewardPoints(createEvent({ user: USER, points: 10, is_winner: false }))).toEqual({
      user: USER,
      points: 10,
      is_winner: false,
    });
  });

  it("decodes a reward_points payload without is_winner", () => {
    expect(decodeRewardPoints(createEvent({ user: USER, points: POINTS }))).toEqual({
      user: USER,
      points: POINTS,
      is_winner: undefined,
    });
  });

  it("falls back to topics for user and points when data is absent", () => {
    expect(decodeRewardPoints(createEvent(null))).toEqual({
      user: USER,
      points: POINTS,
      is_winner: undefined,
    });
  });

  it("falls back to topics for user when data uses address alias", () => {
    expect(decodeRewardPoints(createEvent({ address: USER, points: POINTS }))).toEqual({
      user: USER,
      points: POINTS,
      is_winner: undefined,
    });
  });

  it("rejects invalid payloads", () => {
    expect(() => decodeRewardPoints(createEvent({ user: USER, points: -1 }))).toThrow(
      "non-negative integer",
    );
    expect(() => decodeRewardPoints(createEvent({ user: "bad", points: POINTS }))).toThrow(
      "valid Stellar public key",
    );
  });
});

describe("handleRewardPoints", () => {
  it("updates leaderboard points and win/loss, records the raw event, and invalidates cache", async () => {
    const context = createContext();
    const event = createEvent({ user: USER, points: POINTS, is_winner: true });

    await handleRewardPoints(event, context);

    expect(context.db.query).toHaveBeenCalledTimes(2);
    expect(context.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO leaderboard"),
      [USER, POINTS, 1, 0],
    );
    expect(context.db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO events"),
      [event.ledger, event.txHash, REWARD_POINTS_TOPIC, USER, { user: USER, points: POINTS, is_winner: true }],
    );
    expect(context.redis?.del).toHaveBeenCalledWith("leaderboard:top20");
  });

  it("increments lost_bets when is_winner is false", async () => {
    const context = createContext();
    const event = createEvent({ user: USER, points: 10, is_winner: false });

    await handleRewardPoints(event, context);

    expect(context.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO leaderboard"),
      [USER, 10, 0, 1],
    );
  });

  it("does not increment win/loss when is_winner is undefined", async () => {
    const context = createContext();
    const event = createEvent({ user: USER, points: POINTS });

    await handleRewardPoints(event, context);

    expect(context.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO leaderboard"),
      [USER, POINTS, 0, 0],
    );
  });
});
