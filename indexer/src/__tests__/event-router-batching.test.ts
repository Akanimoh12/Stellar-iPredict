import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeEventsToDb } from "../event-router.js";
import { metrics, resetMetrics } from "../metrics.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const BETTOR = "G" + "A".repeat(55);

function bet(tx: string, eventIndex: number): DecodedContractEvent {
  return {
    ledger: 900,
    txHash: tx.repeat(64),
    eventIndex,
    topics: ["bet_placed", 7, BETTOR],
    data: {
      is_yes: true,
      amount: "100",
      net_amount: "98",
      fee: "2",
      is_increase: eventIndex > 0,
    },
  };
}

function makeDb(): DbClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("jsonb_to_recordset")) {
        return {
          rows: [{ side_valid: true, markets_present: true, event_inserted: "2", applied: "2" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

describe("event-router ledger batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetrics();
  });

  it("routes adjacent bets from one ledger through a single database query", async () => {
    const db = makeDb();

    await writeEventsToDb([bet("a", 0), bet("b", 1)], db, redis);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.query).mock.calls[0][0]).toContain("jsonb_to_recordset");
    expect(metrics.eventsProcessed.get()).toBe(2);
    expect(metrics.eventsByType.get("bet_placed")).toBe(2);
  });

  it("does not reorder bets around another event type", async () => {
    const db = makeDb();
    const cancelled: DecodedContractEvent = {
      ledger: 900,
      txHash: "c".repeat(64),
      eventIndex: 2,
      topics: ["mkt", "cancelled"],
      data: { market_id: 7 },
    };

    await writeEventsToDb([bet("a", 0), cancelled, bet("b", 1)], db, redis);

    const sql = vi.mocked(db.query).mock.calls.map(([query]) => query as string);
    expect(sql).toHaveLength(4);
    expect(sql[0]).toContain("jsonb_to_recordset");
    expect(sql[1]).toContain("INSERT INTO events");
    expect(sql[2]).toContain("UPDATE markets");
    expect(sql[3]).toContain("jsonb_to_recordset");
  });
});
