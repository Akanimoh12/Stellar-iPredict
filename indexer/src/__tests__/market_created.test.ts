import { describe, expect, it, vi } from "vitest";
import { decodeMarketCreatedEvent, handleMarketCreatedEvent } from "../handlers/market_created.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const CREATOR = "GCREAT" + "A".repeat(50);

function sampleEvent(data: unknown = {
  market_id: 7,
  question: "Will BTC reach $100k?",
  category: "Crypto",
  end_time: 1798675200,
  creator: CREATOR,
}): DecodedContractEvent {
  return {
    topics: ["mkt", "created"],
    data,
    ledger: 123456,
    txHash: "abc123",
  };
}

describe("market_created handler", () => {
  it("decodes and validates object payloads", () => {
    expect(decodeMarketCreatedEvent(sampleEvent({ market_id: "7", question: "Q?", category: "Sports", end_time: "100", creator: CREATOR }))).toEqual({
      market_id: 7,
      question: "Q?",
      category: "Sports",
      end_time: 100,
      creator: CREATOR,
      image_url: undefined,
    });
  });

  it("decodes and validates tuple payloads", () => {
    expect(decodeMarketCreatedEvent(sampleEvent([7, "Will ETH flip BTC?", "Politics", 200, CREATOR, "https://img.example/x.png"]))).toEqual({
      market_id: 7,
      question: "Will ETH flip BTC?",
      category: "Politics",
      end_time: 200,
      creator: CREATOR,
      image_url: "https://img.example/x.png",
    });
  });

  it("rejects malformed payloads before writes", async () => {
    const db: DbClient = { query: vi.fn() };
    const redis: RedisClient = { del: vi.fn() };

    await expect(handleMarketCreatedEvent(sampleEvent({ market_id: -1, question: "Q", category: "Crypto", end_time: 1, creator: CREATOR }), db, redis)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("inserts the market idempotently and invalidates affected cache keys", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(3) };

    await expect(handleMarketCreatedEvent(sampleEvent(), db, redis)).resolves.toEqual({
      market_id: 7,
      question: "Will BTC reach $100k?",
      category: "Crypto",
      end_time: 1798675200,
      creator: CREATOR,
      image_url: undefined,
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO markets"),
      [7, "Will BTC reach $100k?", null, "Crypto", 1798675200, CREATOR],
    );
    expect(redis.del).toHaveBeenCalledWith("market:7", "markets:all", "markets:active");
  });
});
