import { describe, expect, it, vi } from "vitest";
import { Indexer } from "../indexer/src/index.js";
import { recomputeMarketTotalsFromBets } from "../indexer/src/recomputeTotals.js";
import type { Queryable } from "../indexer/src/db.js";

function dbMock(rowsBySql: Record<string, unknown[]> = {}) {
  const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
  return {
    queries,
    async query<T = unknown>(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, params });
      const key = Object.keys(rowsBySql).find(k => sql.includes(k));
      return { rows: (key ? rowsBySql[key] : []) as T[], rowCount: 0 };
    },
    async end() {},
  };
}

describe("indexer hardening", () => {
  it("recomputes market totals from persisted bets", async () => {
    const db = dbMock({ "SELECT COUNT": [{ count: "2" }], "SELECT id FROM updated": [{ id: "1" }] });
    const result = await recomputeMarketTotalsFromBets(db as Queryable);
    expect(result).toEqual({ checked: 2, corrected: 1 });
    expect(db.queries[0].sql).toContain("SUM(CASE WHEN is_yes THEN net_amount");
    expect(db.queries[0].sql).toContain("UPDATE markets");
  });

  it("dead-letters undecodable events and still checkpoints", async () => {
    const db = dbMock();
    const runtime = {
      db,
      getCheckpoint: vi.fn(async () => 10),
      saveCheckpoint: vi.fn(async () => undefined),
      fetchEvents: vi.fn(async () => ({ latestLedger: 11, events: [{ ledger: 11, txHash: "a".repeat(64) }] })),
      decodeEvent: vi.fn(() => { throw new Error("bad xdr"); }),
      writeEventToDb: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
    };
    const indexer = new Indexer(runtime as never);
    await indexer.indexOnce();

    expect(db.queries[0].sql).toContain("dead_letter_events");
    expect(db.queries[0].params?.[3]).toBe("bad xdr");
    expect(runtime.saveCheckpoint).toHaveBeenCalledWith(11);
  });

  it("flushes checkpoint and closes db/redis on shutdown", async () => {
    const db = dbMock();
    const redis = { del: vi.fn(), end: vi.fn(async () => undefined) };
    const runtime = {
      db: { ...db, end: vi.fn(async () => undefined) },
      redis,
      getCheckpoint: vi.fn(async () => 7),
      saveCheckpoint: vi.fn(async () => undefined),
      fetchEvents: vi.fn(async () => ({ latestLedger: 7, events: [] })),
      decodeEvent: vi.fn(),
      writeEventToDb: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };
    const indexer = new Indexer(runtime as never);
    await indexer.flushAndClose();
    expect(runtime.saveCheckpoint).toHaveBeenCalledWith(0);
    expect(redis.end).toHaveBeenCalled();
    expect(runtime.db.end).toHaveBeenCalled();
  });
});
