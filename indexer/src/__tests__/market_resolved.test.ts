import { describe, expect, it, vi } from "vitest";
import { decodeMarketResolvedEvent, handleMarketResolvedEvent } from "../handlers/market_resolved.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

function sampleEvent(data: unknown = { market_id: 42, outcome: true }): DecodedContractEvent {
  return {
    topics: ["market_resolved"],
    data,
    ledger: 123456,
    txHash: "abc123",
  };
}

describe("market_resolved handler", () => {
  it("decodes and validates object payloads", () => {
    expect(decodeMarketResolvedEvent(sampleEvent({ market_id: "42", outcome: true }))).toEqual({
      market_id: 42,
      outcome: true,
    });
  });

  it("decodes and validates tuple payloads", () => {
    expect(decodeMarketResolvedEvent(sampleEvent([42, false]))).toEqual({
      market_id: 42,
      outcome: false,
    });
  });

  it("accepts documented legacy mkt/resolved topics", () => {
    expect(
      decodeMarketResolvedEvent({
        topics: ["mkt", "resolved"],
        data: { market_id: 7, outcome: "yes" },
      }),
    ).toEqual({ market_id: 7, outcome: true });
  });

  it("rejects malformed payloads before writes", async () => {
    const db: DbClient = { query: vi.fn() };
    const redis: RedisClient = { del: vi.fn() };

    await expect(handleMarketResolvedEvent(sampleEvent({ market_id: 42 }), db, redis)).rejects.toThrow();
    await expect(handleMarketResolvedEvent(sampleEvent({ market_id: 42, outcome: true, extra: "nope" }), db, redis)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("logs the event, marks the market resolved idempotently, and invalidates affected cache keys", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

    await expect(handleMarketResolvedEvent(sampleEvent(), db, redis)).resolves.toEqual({
      market_id: 42,
      outcome: true,
    });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO events"),
      [123456, "abc123", "market_resolved", 42, JSON.stringify({ market_id: 42, outcome: true })],
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET resolved = TRUE"),
      [42, true],
    );
    expect(redis.del).toHaveBeenCalledWith("market:42", "markets:all", "markets:active");
    expect(redis.del).toHaveBeenCalledWith("leaderboard:top20");
  });

});
