import { describe, expect, it, vi } from "vitest";
import {
  decodeBetPlacedEvent,
  handleBetPlacedEvent,
  handleBetPlacedEvents,
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
      expect.stringContaining("jsonb_to_recordset"),
      [expect.any(String)],
    );
    expect(JSON.parse(vi.mocked(db.query).mock.calls[0][1]?.[0] as string)).toEqual([
      expect.objectContaining({
        ordinal: 0,
        ledger_seq: event.ledger,
        tx_hash: event.txHash,
        event_index: "2",
        market_id: 7,
        bettor: BETTOR,
        net_amount: "980000000",
        gross_amount: "1000000000",
        is_yes: true,
      }),
    ]);
    const query = vi.mocked(db.query).mock.calls[0]?.[0] ?? "";
    expect(query).toContain("INSERT INTO bets");
    expect(query).toContain("UPDATE markets");
    expect(query).toContain("ON CONFLICT (tx_hash, event_index) DO NOTHING");
    expect(query).toContain("(xmax = 0) AS new_bettor");
    expect(query).toContain("invariant_guard");
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

  it("batches ordered placements from one ledger into one atomic SQL statement", async () => {
    const otherBettor = "G" + "B".repeat(55);
    const first = sampleEvent();
    const second: DecodedContractEvent = {
      ...sampleEvent({
        market_id: 8,
        bettor: otherBettor,
        is_yes: false,
        amount: 500n,
        net_amount: 490n,
        fee: 10n,
        is_increase: false,
      }),
      topics: ["bet"],
      txHash: "b".repeat(64),
      eventIndex: 0,
    };
    const db: DbClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ side_valid: true, markets_present: true, event_inserted: "2", applied: "2" }],
        rowCount: 1,
      }),
    };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

    await expect(handleBetPlacedEvents([first, second], db, redis)).resolves.toHaveLength(2);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    const rows = JSON.parse(params?.[0] as string);
    expect(rows.map((row: { tx_hash: string }) => row.tx_hash)).toEqual([
      first.txHash,
      second.txHash,
    ]);
    expect(sql).toContain("DISTINCT ON (tx_hash, event_index)");
    expect(sql).toContain("GROUP BY market_id, bettor, is_yes");
    expect(redis.del).toHaveBeenCalledTimes(2);
  });

  it("rejects mixed-ledger batches before any write", async () => {
    const db: DbClient = { query: vi.fn() };
    const redis: RedisClient = { del: vi.fn() };

    await expect(
      handleBetPlacedEvents(
        [sampleEvent(), { ...sampleEvent(), ledger: 123457, txHash: "b".repeat(64) }],
        db,
        redis,
      ),
    ).rejects.toThrow("exactly one ledger");
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("does not invalidate caches when the atomic batch statement rolls back", async () => {
    const db: DbClient = { query: vi.fn().mockRejectedValue(new Error("transaction aborted")) };
    const redis: RedisClient = { del: vi.fn() };

    await expect(handleBetPlacedEvents([sampleEvent()], db, redis)).rejects.toThrow(
      "transaction aborted",
    );
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("deduplicates duplicate delivery in SQL and still repairs cache invalidation on retry", async () => {
    const event = sampleEvent();
    const db: DbClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ side_valid: true, markets_present: true, event_inserted: "0", applied: "0" }],
        rowCount: 1,
      }),
    };
    const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

    await handleBetPlacedEvents([event, { ...event }], db, redis);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.query).mock.calls[0][0]).toContain(
      "ON CONFLICT (tx_hash, event_index) DO NOTHING",
    );
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate event key with a contradictory payload", async () => {
    const event = sampleEvent();
    const db: DbClient = { query: vi.fn() };
    const redis: RedisClient = { del: vi.fn() };

    await expect(
      handleBetPlacedEvents(
        [event, { ...event, data: { ...event.data as object, is_yes: false } }],
        db,
        redis,
      ),
    ).rejects.toThrow("conflicting payloads");
    expect(db.query).not.toHaveBeenCalled();
  });
});
