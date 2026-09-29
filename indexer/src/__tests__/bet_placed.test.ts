import { describe, expect, it, vi } from "vitest";
import {
  decodeBetPlacedEvent,
  handleBetPlacedEvent,
} from "../handlers/bet_placed.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const BETTOR = "G" + "A".repeat(55);

function sampleEvent(
  data: unknown = {
    is_yes: true,
    amount: 1_000_000_000n,
    net_amount: 980_000_000n,
    fee: 20_000_000n,
    is_increase: false,
  },
): DecodedContractEvent {
  return {
    topics: ["bet_placed", 7, BETTOR],
    data,
    ledger: 123456,
    txHash: "a".repeat(64),
    eventIndex: 2,
  };
}

describe("bet_placed handler", () => {
  it("decodes a placement event and preserves i128 amounts as strings", () => {
    expect(decodeBetPlacedEvent(sampleEvent())).toEqual({
      market_id: 7,
      bettor: BETTOR,
      is_yes: true,
      amount: "1000000000",
      net_amount: "980000000",
      fee: "20000000",
      is_increase: false,
    });
  });

  it("decodes the canonical compact tuple payload", () => {
    expect(
      decodeBetPlacedEvent({
        topics: ["bet"],
        data: [7n, BETTOR, false, 500_000_000n, 490_000_000n, 10_000_000n, true],
      }),
    ).toEqual({
      market_id: 7,
      bettor: BETTOR,
      is_yes: false,
      amount: "500000000",
      net_amount: "490000000",
      fee: "10000000",
      is_increase: true,
    });
  });

  it("accepts the one-stroop rounding remainder produced by the contract fee calculation", () => {
    expect(
      decodeBetPlacedEvent({
        topics: ["bet", "placed", 7, BETTOR],
        data: {
          amount: 51n,
          net_amount: 49n,
          fee: 1n,
          is_yes: true,
          is_increase: false,
        },
      }),
    ).toMatchObject({
      market_id: 7,
      bettor: BETTOR,
      amount: "51",
      net_amount: "49",
      fee: "1",
    });
  });

  it("rejects malformed payloads before writing", async () => {
    const db: DbClient = { query: vi.fn() };
    const redis: RedisClient = { del: vi.fn() };

    await expect(
      handleBetPlacedEvent(
        sampleEvent({
          is_yes: true,
          amount: 100n,
          net_amount: 101n,
          fee: 0n,
          is_increase: false,
        }),
        db,
        redis,
      ),
    ).rejects.toThrow("net_amount must not exceed amount");

    expect(db.query).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("upserts the position, updates market aggregates, and invalidates affected caches", async () => {
    const db: DbClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ side_valid: true, event_inserted: true, applied: true }],
        rowCount: 1,
      }),
    };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(2) };
    const event = sampleEvent();

    await expect(handleBetPlacedEvent(event, db, redis)).resolves.toEqual({
      market_id: 7,
      bettor: BETTOR,
      is_yes: true,
      amount: "1000000000",
      net_amount: "980000000",
      fee: "20000000",
      is_increase: false,
    });

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO events"),
      [
        event.ledger,
        event.txHash,
        event.eventIndex,
        "bet_placed",
        JSON.stringify({
          market_id: 7,
          bettor: BETTOR,
          is_yes: true,
          amount: "1000000000",
          net_amount: "980000000",
          fee: "20000000",
          is_increase: false,
        }),
        7,
        BETTOR,
        "980000000",
        "1000000000",
        true,
      ],
    );
    const query = vi.mocked(db.query).mock.calls[0]?.[0] ?? "";
    expect(query).toContain("INSERT INTO bets");
    expect(query).toContain("UPDATE markets");
    expect(query).toContain("ON CONFLICT (tx_hash, event_index) DO NOTHING");
    expect(query).toContain("(xmax = 0) AS new_bettor");
    expect(redis.del).toHaveBeenCalledWith(
      "ipredict:v1:market:7",
      "ipredict:v1:markets:active",
    );
  });

  it("does not reapply a previously processed event, but retries cache invalidation", async () => {
    const db: DbClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ side_valid: true, event_inserted: false, applied: false }],
        rowCount: 1,
      }),
    };
    const redis: RedisClient = { del: vi.fn() };

    await handleBetPlacedEvent(sampleEvent(), db, redis);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(
      "ipredict:v1:market:7",
      "ipredict:v1:markets:active",
    );
  });
});
