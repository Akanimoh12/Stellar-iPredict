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
    await vi.runAllTimersAsync();
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

    await vi.runAllTimersAsync();
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
