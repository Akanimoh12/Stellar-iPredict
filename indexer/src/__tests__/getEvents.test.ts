import { describe, expect, it, vi, beforeEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { SorobanRpcClient, LedgerGapError } from "../rpc/getEvents.js";

describe("SorobanRpcClient.getEvents", () => {
  let client: SorobanRpcClient;

  beforeEach(() => {
    client = new SorobanRpcClient("https://mock-rpc-url.stellar.org");
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
});
