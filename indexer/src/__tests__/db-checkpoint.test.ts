import { describe, it, expect, vi } from "vitest";
import {
  CHECKPOINT_TABLE_NAME,
  CHECKPOINT_ID,
  ensureCheckpointTable,
  getCheckpointLedger,
  saveCheckpointLedger,
  withTransaction,
  processEventsWithCheckpointAtomic,
  type Queryable,
} from "../db.js";

describe("Database Checkpoint & Transaction Helpers", () => {
  it("ensureCheckpointTable creates the checkpoints table if not exists", async () => {
    const mockDb: Queryable = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await ensureCheckpointTable(mockDb);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining(`CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE_NAME}`)
    );
  });

  it("getCheckpointLedger retrieves existing checkpoint ledger", async () => {
    const mockDb: Queryable = {
      query: vi.fn().mockResolvedValue({
        rows: [{ last_ledger_seq: "12345" }],
      }),
    };

    const ledger = await getCheckpointLedger(mockDb);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining(`SELECT last_ledger_seq FROM ${CHECKPOINT_TABLE_NAME}`),
      [CHECKPOINT_ID]
    );
    expect(ledger).toBe(12345);
  });

  it("getCheckpointLedger returns null when table has no row", async () => {
    const mockDb: Queryable = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const ledger = await getCheckpointLedger(mockDb);
    expect(ledger).toBeNull();
  });

  it("saveCheckpointLedger inserts/upserts the singleton checkpoint", async () => {
    const mockDb: Queryable = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await saveCheckpointLedger(mockDb, 999);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining(`INSERT INTO ${CHECKPOINT_TABLE_NAME}`),
      [CHECKPOINT_ID, 999]
    );
  });

  it("withTransaction executes within BEGIN/COMMIT and returns action result", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(client),
    };

    const result = await withTransaction(mockPool as any, async (txClient) => {
      await txClient.query("SELECT 1");
      return "done";
    });

    expect(result).toBe("done");
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "SELECT 1");
    expect(client.query).toHaveBeenNthCalledWith(3, "COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("withTransaction rolls back and releases client when action throws", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(client),
    };

    await expect(
      withTransaction(mockPool as any, async () => {
        throw new Error("action failed");
      })
    ).rejects.toThrow("action failed");

    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("processEventsWithCheckpointAtomic processes all events then saves checkpoint", async () => {
    const queries: string[] = [];
    const client: Queryable = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };

    const events = [{ id: 1 }, { id: 2 }];
    const processedEvents: number[] = [];

    await processEventsWithCheckpointAtomic(
      client,
      events,
      500,
      async (ev) => {
        processedEvents.push(ev.id);
      }
    );

    expect(processedEvents).toEqual([1, 2]);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining(`INSERT INTO ${CHECKPOINT_TABLE_NAME}`),
      [CHECKPOINT_ID, 500]
    );
  });
});
