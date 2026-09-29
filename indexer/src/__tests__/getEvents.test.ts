import { describe, expect, it, vi, beforeEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import {
  SorobanRpcClient,
  LedgerGapError,
  RetentionExceededError,
  checkRetentionBoundary,
  isRetentionExceededError,
  extractOldestLedger,
} from "../rpc/getEvents.js";
import { metrics, resetMetrics } from "../metrics.js";

describe("SorobanRpcClient.getEvents", () => {
  let client: SorobanRpcClient;

  const TEST_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    resetMetrics();
    client = new SorobanRpcClient("https://mock-rpc-url.stellar.org", [TEST_CONTRACT]);
    vi.restoreAllMocks();
  });

  it("successfully retrieves and maps events on the happy path", async () => {
    const mockEventsResponse = {
      events: [
        {
          contractId: { toString: () => "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
          ledger: 1000,
          type: "contract",
          topic: ["mkt", "cancelled"],
          value: "XDR_VAL",
        },
      ],
      latestLedger: 1005,
    };

    const spy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValue(mockEventsResponse as any);

    const result = await client.getEvents({
      startLedger: 1000,
      contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    });

    expect(spy).toHaveBeenCalledWith({
      startLedger: 1000,
      filters: [
        {
          type: "contract",
          contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        },
      ],
      limit: 100,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ledger: 1000,
      type: "contract",
      body: mockEventsResponse.events[0],
    });
    expect(result.latestLedger).toBe(1005);
  });

  it("throws LedgerGapError when startLedger is too old", async () => {
    const rpcError = new Error("startLedger is less than the oldest ledger stored in this node (100000)");

    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValue(rpcError);

    await expect(
      client.getEvents({
        startLedger: 5000,
        contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      })
    ).rejects.toThrow(LedgerGapError);

    await expect(
      client.getEvents({
        startLedger: 5000,
        contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      })
    ).rejects.toThrow(/re-backfill/);
  });

  it("propagates other unrelated errors without modification", async () => {
    const rpcError = new Error("network timeout");

    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValue(rpcError);

    await expect(
      client.getEvents({
        startLedger: 5000,
        contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      })
    ).rejects.toThrow("network timeout");

    await expect(
      client.getEvents({
        startLedger: 5000,
        contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      })
    ).rejects.not.toThrow(LedgerGapError);
    expect(metrics.rpcErrors.get({ service: "indexer", operation: "getEvents" })).toBe(2);
  });

  it("follows the cursor to fetch all pages of events", async () => {
    const page1Events = [
      {
        contractId: { toString: () => "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        ledger: 1000,
        type: "contract",
        topic: ["mkt", "cancelled"],
        value: "XDR_VAL_1",
      },
    ];
    const page2Events = [
      {
        contractId: { toString: () => "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        ledger: 1001,
        type: "contract",
        topic: ["bet", "placed"],
        value: "XDR_VAL_2",
      },
    ];

    const spy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({
        events: page1Events,
        latestLedger: 1005,
        cursor: "next-cursor",
      } as any)
      .mockResolvedValueOnce({
        events: page2Events,
        latestLedger: 1010,
      } as any);

    const result = await client.getEvents({
      startLedger: 1000,
      contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    });

    expect(spy).toHaveBeenCalledTimes(2);

    expect(spy.mock.calls[0][0]).toEqual({
      startLedger: 1000,
      filters: [
        {
          type: "contract",
          contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        },
      ],
      limit: 100,
    });

    expect(spy.mock.calls[1][0]).toEqual({
      cursor: "next-cursor",
      filters: [
        {
          type: "contract",
          contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        },
      ],
      limit: 100,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ledger: 1000,
      type: "contract",
      body: page1Events[0],
    });
    expect(result.events[1]).toEqual({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ledger: 1001,
      type: "contract",
      body: page2Events[0],
    });
    expect(result.latestLedger).toBe(1010);
  });

  it("stops paginating when cursor is empty string", async () => {
    const pageEvents = [
      {
        contractId: { toString: () => "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        ledger: 2000,
        type: "contract",
        topic: ["mkt", "created"],
        value: "XDR_VAL",
      },
    ];

    const spy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce({
        events: pageEvents,
        latestLedger: 2005,
        cursor: "",
      } as any);

    const result = await client.getEvents({
      startLedger: 2000,
      contractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(1);
    expect(result.latestLedger).toBe(2005);
  });

  it("throws RetentionExceededError and specifies unavailable ledger range when startLedger is beyond retention", async () => {
    const rpcError = new Error("startLedger is less than the oldest ledger stored in this node (100000)");

    vi.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValue(rpcError);

    try {
      await client.getEvents({
        startLedger: 5000,
        contractIds: [TEST_CONTRACT],
      });
      expect.fail("Expected getEvents to throw RetentionExceededError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(RetentionExceededError);
      expect(err).toBeInstanceOf(LedgerGapError);
      expect(err.startLedger).toBe(5000);
      expect(err.oldestLedger).toBe(100000);
      expect(err.unavailableRange).toEqual({ fromLedger: 5000, toLedger: 99999 });
      expect(err.message).toContain("Unavailable ledger range: [5000..99999]");
      expect(err.message).toContain("95000 ledgers unavailable: 5000 to 99999");
    }
  });

  describe("checkRetentionBoundary", () => {
    it("logs warning alert when indexer position is close to retention boundary", async () => {
      const mockServer = {
        getHealth: vi.fn().mockResolvedValue({
          status: "healthy",
          latestLedger: 200000,
          oldestLedger: 100000,
          ledgerRetentionWindow: 120960,
        }),
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Indexer at 105000, oldestLedger at 100000 -> distance is 5000 (within 17280 threshold)
      const status = await checkRetentionBoundary(mockServer as any, 105000, 17280);

      expect(status).not.toBeNull();
      expect(status?.isApproachingRetention).toBe(true);
      expect(status?.distanceToRetention).toBe(5000);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ALERT: Approaching Soroban RPC retention boundary!")
      );

      warnSpy.mockRestore();
    });

    it("does not alert when indexer position is well ahead of retention boundary", async () => {
      const mockServer = {
        getHealth: vi.fn().mockResolvedValue({
          status: "healthy",
          latestLedger: 200000,
          oldestLedger: 100000,
          ledgerRetentionWindow: 120960,
        }),
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Indexer at 150000, oldestLedger at 100000 -> distance is 50000 (above 17280 threshold)
      const status = await checkRetentionBoundary(mockServer as any, 150000, 17280);

      expect(status).not.toBeNull();
      expect(status?.isApproachingRetention).toBe(false);
      expect(status?.distanceToRetention).toBe(50000);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});

