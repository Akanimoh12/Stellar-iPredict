import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollOnce, runPollLoop, type RpcClient, type PollDb, type RpcEvent } from "../poll-loop.js";

function makeRpcEvent(overrides: Partial<RpcEvent> = {}): RpcEvent {
  return {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ledger: 100,
    type: "transfer",
    body: {},
    ...overrides,
  };
}

function makeMockRpc(
  result: { events: RpcEvent[]; latestLedger: number }
): RpcClient {
  return {
    getEvents: vi.fn().mockResolvedValue(result),
  };
}

function makeMockDb(checkpoint: number | null = null): PollDb {
  return {
    getCheckpointLedger: vi.fn().mockResolvedValue(checkpoint),
    saveCheckpointLedger: vi.fn().mockResolvedValue(undefined),
    insertEvents: vi.fn().mockResolvedValue(undefined),
  };
}

const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("pollOnce", () => {
  it("starts from defaultStartLedger when no checkpoint exists", async () => {
    const event = makeRpcEvent({ contractId: CONTRACT_A, ledger: 50 });
    const rpc = makeMockRpc({ events: [event], latestLedger: 55 });
    const db = makeMockDb(null);

    await pollOnce({ rpc, db, contractIds: [CONTRACT_A], defaultStartLedger: 42 });

    expect(rpc.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 42, contractIds: [CONTRACT_A] })
    );
  });

  it("resumes from checkpoint + 1 when checkpoint exists", async () => {
    const rpc = makeMockRpc({ events: [], latestLedger: 200 });
    const db = makeMockDb(150);

    await pollOnce({ rpc, db, contractIds: [CONTRACT_A] });

    expect(rpc.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 151 })
    );
  });

  it("inserts returned events and saves checkpoint", async () => {
    const event = makeRpcEvent({ contractId: CONTRACT_A, ledger: 100 });
    const rpc = makeMockRpc({ events: [event], latestLedger: 105 });
    const db = makeMockDb(null);

    const result = await pollOnce({ rpc, db, contractIds: [CONTRACT_A] });

    expect(db.insertEvents).toHaveBeenCalledWith([event]);
    expect(db.saveCheckpointLedger).toHaveBeenCalledWith(105);
    expect(result.eventsWritten).toBe(1);
    expect(result.latestLedger).toBe(105);
  });

  it("skips insertEvents when no events are returned", async () => {
    const rpc = makeMockRpc({ events: [], latestLedger: 200 });
    const db = makeMockDb(null);

    await pollOnce({ rpc, db, contractIds: [CONTRACT_A] });

    expect(db.insertEvents).not.toHaveBeenCalled();
    expect(db.saveCheckpointLedger).toHaveBeenCalledWith(200);
  });

  it("returns correct eventsWritten count", async () => {
    const events = [
      makeRpcEvent({ contractId: CONTRACT_A, ledger: 10 }),
      makeRpcEvent({ contractId: CONTRACT_A, ledger: 11 }),
      makeRpcEvent({ contractId: CONTRACT_B, ledger: 12 }),
    ];
    const rpc = makeMockRpc({ events, latestLedger: 15 });
    const db = makeMockDb(null);

    const result = await pollOnce({ rpc, db, contractIds: [CONTRACT_A, CONTRACT_B] });

    expect(result.eventsWritten).toBe(3);
  });
});

describe("runPollLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("polls repeatedly until signal is aborted", async () => {
    const rpc = makeMockRpc({ events: [], latestLedger: 100 });
    const db = makeMockDb(null);
    const controller = new AbortController();

    const loopPromise = runPollLoop(
      { rpc, db, contractIds: [CONTRACT_A], pollIntervalMs: 1000 },
      controller.signal
    );

    // First poll fires immediately
    await Promise.resolve();
    expect(rpc.getEvents).toHaveBeenCalledTimes(1);

    // Advance past the interval to trigger a second poll
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.getEvents).toHaveBeenCalledTimes(2);

    controller.abort();
    await loopPromise;
  });

  it("continues after an RPC error and retries on the next interval", async () => {
    const rpc: RpcClient = {
      getEvents: vi
        .fn()
        .mockRejectedValueOnce(new Error("network timeout"))
        .mockResolvedValue({ events: [], latestLedger: 100 }),
    };
    const db = makeMockDb(null);
    const controller = new AbortController();

    const loopPromise = runPollLoop(
      { rpc, db, contractIds: [CONTRACT_A], pollIntervalMs: 500 },
      controller.signal
    );

    await Promise.resolve();
    expect(rpc.getEvents).toHaveBeenCalledTimes(1);

    // Advance past the interval — second call should succeed
    await vi.advanceTimersByTimeAsync(500);
    expect(rpc.getEvents).toHaveBeenCalledTimes(2);
    // checkpoint should be saved on the successful second call
    expect(db.saveCheckpointLedger).toHaveBeenCalledWith(100);

    controller.abort();
    await loopPromise;
  });

  it("exits immediately when signal is already aborted", async () => {
    const rpc = makeMockRpc({ events: [], latestLedger: 100 });
    const db = makeMockDb(null);
    const controller = new AbortController();
    controller.abort();

    await runPollLoop({ rpc, db, contractIds: [CONTRACT_A] }, controller.signal);

    expect(rpc.getEvents).not.toHaveBeenCalled();
  });
});

describe("Atomicity & Crash-Recovery Guarantees", () => {
  it("commits cursor position and event effects atomically using processEventsWithCheckpoint when implemented", async () => {
    const event = makeRpcEvent({ contractId: CONTRACT_A, ledger: 101 });
    const rpc = makeMockRpc({ events: [event], latestLedger: 105 });

    const processEventsWithCheckpoint = vi.fn().mockResolvedValue(undefined);
    const insertEvents = vi.fn();
    const saveCheckpointLedger = vi.fn();

    const db: PollDb = {
      getCheckpointLedger: vi.fn().mockResolvedValue(100),
      saveCheckpointLedger,
      insertEvents,
      processEventsWithCheckpoint,
    };

    const result = await pollOnce({ rpc, db, contractIds: [CONTRACT_A] });

    expect(processEventsWithCheckpoint).toHaveBeenCalledWith([event], 105);
    // Non-atomic fallback methods should NOT be called when atomic handler is used
    expect(insertEvents).not.toHaveBeenCalled();
    expect(saveCheckpointLedger).not.toHaveBeenCalled();
    expect(result.latestLedger).toBe(105);
  });

  it("ensures deliberate ordering: inserts events before advancing checkpoint in fallback mode", async () => {
    const event = makeRpcEvent({ contractId: CONTRACT_A, ledger: 101 });
    const rpc = makeMockRpc({ events: [event], latestLedger: 105 });

    const executionOrder: string[] = [];
    const db: PollDb = {
      getCheckpointLedger: vi.fn().mockResolvedValue(100),
      insertEvents: vi.fn().mockImplementation(async () => {
        executionOrder.push("insertEvents");
      }),
      saveCheckpointLedger: vi.fn().mockImplementation(async () => {
        executionOrder.push("saveCheckpointLedger");
      }),
    };

    await pollOnce({ rpc, db, contractIds: [CONTRACT_A] });

    expect(executionOrder).toEqual(["insertEvents", "saveCheckpointLedger"]);
  });

  it("crash mid-batch never causes an event to be permanently skipped, and reprocessing produces no duplicated effects", async () => {
    // Simulated database state
    let persistedCheckpoint: number | null = 100;
    const appliedEvents: Array<{ txHash: string; eventIndex: number; ledger: number; payload: string }> = [];
    const eventAuditLog = new Set<string>(); // Simulates UNIQUE(tx_hash, event_index)

    // Idempotent event applicator simulating handler behavior with insertProcessedEvent
    const applyEventIdempotent = (event: { txHash: string; eventIndex: number; ledger: number; payload: string }) => {
      const key = `${event.txHash}:${event.eventIndex}`;
      if (eventAuditLog.has(key)) {
        // Duplicate skipped due to ON CONFLICT (tx_hash, event_index) DO NOTHING
        return false;
      }
      eventAuditLog.add(key);
      appliedEvents.push(event);
      return true;
    };

    const batchEvents: RpcEvent[] = [
      makeRpcEvent({ contractId: CONTRACT_A, ledger: 101, body: { txHash: "tx1", eventIndex: 0, val: "A" } }),
      makeRpcEvent({ contractId: CONTRACT_A, ledger: 102, body: { txHash: "tx2", eventIndex: 0, val: "B" } }),
      makeRpcEvent({ contractId: CONTRACT_A, ledger: 103, body: { txHash: "tx3", eventIndex: 0, val: "C" } }),
    ];

    const rpc: RpcClient = {
      getEvents: vi.fn().mockImplementation(async ({ startLedger }) => {
        const events = batchEvents.filter((e) => e.ledger >= startLedger);
        return { events, latestLedger: 103 };
      }),
    };

    // Step 1: Initial poll fails/crashes mid-batch (e.g. after processing second event)
    let shouldCrash = true;
    const db: PollDb = {
      getCheckpointLedger: async () => persistedCheckpoint,
      saveCheckpointLedger: async (ledger: number) => {
        persistedCheckpoint = ledger;
      },
      insertEvents: async () => {},
      processEventsWithCheckpoint: async (events: RpcEvent[], checkpointLedger: number) => {
        // Atomic transaction simulator
        const staging: typeof appliedEvents = [];
        const stagingKeys: string[] = [];

        for (let i = 0; i < events.length; i++) {
          if (shouldCrash && i === 2) {
            // Simulated crash mid-batch before commit
            throw new Error("Simulated node crash mid-batch");
          }
          const body = events[i].body as any;
          const key = `${body.txHash}:${body.eventIndex}`;
          if (!eventAuditLog.has(key)) {
            stagingKeys.push(key);
            staging.push({
              txHash: body.txHash,
              eventIndex: body.eventIndex,
              ledger: events[i].ledger,
              payload: body.val,
            });
          }
        }

        // Commit transaction atomically
        for (const k of stagingKeys) eventAuditLog.add(k);
        for (const item of staging) appliedEvents.push(item);
        persistedCheckpoint = checkpointLedger;
      },
    };

    // Poll attempt 1: Crashes mid-batch
    await expect(pollOnce({ rpc, db, contractIds: [CONTRACT_A] })).rejects.toThrow("Simulated node crash mid-batch");

    // Assert that checkpoint was NOT updated after the crash
    expect(persistedCheckpoint).toBe(100);
    // Assert that atomic rollback prevented partial uncommitted effects
    expect(appliedEvents).toHaveLength(0);

    // Step 2: Recovery poll after indexer restart
    shouldCrash = false;
    const recoveryResult = await pollOnce({ rpc, db, contractIds: [CONTRACT_A] });

    // Assert that recovery re-polled starting from checkpoint + 1 (101)
    expect(rpc.getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ startLedger: 101 })
    );

    // Assert all 3 events are processed without any being skipped
    expect(appliedEvents).toHaveLength(3);
    expect(appliedEvents.map((e) => e.txHash)).toEqual(["tx1", "tx2", "tx3"]);

    // Assert checkpoint is successfully advanced to 103
    expect(persistedCheckpoint).toBe(103);
    expect(recoveryResult.latestLedger).toBe(103);

    // Step 3: Reprocessing the exact same range (e.g. redundant replay) produces no duplicate effects
    const replayResult = await pollOnce({
      rpc: {
        getEvents: vi.fn().mockResolvedValue({ events: batchEvents, latestLedger: 103 }),
      },
      db,
      contractIds: [CONTRACT_A],
    });

    // Still exactly 3 applied events due to idempotency
    expect(appliedEvents).toHaveLength(3);
    expect(replayResult.latestLedger).toBe(103);
  });
});

