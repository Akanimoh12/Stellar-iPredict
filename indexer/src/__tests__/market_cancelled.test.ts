import { describe, expect, it, vi } from "vitest";
import { decodeMarketCancelledEvent, handleMarketCancelledEvent } from "../handlers/market_cancelled.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

function sampleEvent(data: unknown = { market_id: 42 }): DecodedContractEvent {
  return {
    topics: ["mkt", "cancelled"],
    data,
    ledger: 123456,
    txHash: "abc123",
  };
}

describe("market_cancelled handler", () => {
  it("decodes and validates object payloads", () => {
    expect(decodeMarketCancelledEvent(sampleEvent({ market_id: "42" }))).toEqual({ market_id: 42 });
  });

  it("decodes and validates tuple payloads", () => {
    expect(decodeMarketCancelledEvent(sampleEvent([42]))).toEqual({ market_id: 42 });
  });

  it("rejects malformed payloads before writes", async () => {
    const db: DbClient = { query: vi.fn() };
    const redis: RedisClient = { del: vi.fn() };

    await expect(handleMarketCancelledEvent(sampleEvent({ market_id: -1 }), db, redis)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("marks the market cancelled idempotently and invalidates affected cache keys", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(3) };

    await expect(handleMarketCancelledEvent(sampleEvent(), db, redis)).resolves.toEqual({ market_id: 42 });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("SET cancelled = TRUE"), [42]);
    expect(redis.del).toHaveBeenCalledWith("market:42", "markets:all", "markets:active");
  });
});
