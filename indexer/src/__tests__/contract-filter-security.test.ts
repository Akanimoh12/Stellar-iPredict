import { describe, it, expect, vi } from "vitest";
import { SorobanRpcClient } from "../rpc/getEvents.js";

const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const UNKNOWN_CONTRACT = "CUNKNOWNCONTRACTUNKNOWNCONTRACTUNKNOWNCONTRACTUNKNOWNC";

describe("contract filter security", () => {
  it("rejects events from unknown contracts before decoding", async () => {
    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    // Mock RPC server that returns events from both allowed and unknown contracts
    const mockServerResponse = {
      latestLedger: 100,
      cursor: undefined,
      events: [
        {
          contractId: VALID_CONTRACT_A,
          ledger: 99,
          type: "contract",
          topics: ["market", "created"],
        },
        {
          contractId: UNKNOWN_CONTRACT, // This should be rejected
          ledger: 100,
          type: "contract",
          topics: ["malicious", "event"],
        },
      ],
    };

    const mockRpcServer = {
      getEvents: vi.fn().mockResolvedValue(mockServerResponse),
    };

    // Create client with only VALID_CONTRACT_A in allowlist
    const client = new SorobanRpcClient(
      "http://localhost:8000",
      [VALID_CONTRACT_A],
      mockLogger
    );

    // Replace the internal server with our mock
    (client as any).server = mockRpcServer;

    const result = await client.getEvents({
      startLedger: 1,
      contractIds: [VALID_CONTRACT_A],
    });

    // Should only include the event from the allowed contract
    expect(result.events).toHaveLength(1);
    expect(result.events[0].contractId).toBe(VALID_CONTRACT_A);

    // Should log rejection of unknown contract
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "rejected event from unconfigured contract",
      expect.objectContaining({
        contractId: UNKNOWN_CONTRACT,
        ledger: 100,
      })
    );
  });

  it("filters events before any decoding happens", async () => {
    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const mockServerResponse = {
      latestLedger: 100,
      cursor: undefined,
      events: [
        {
          contractId: UNKNOWN_CONTRACT,
          ledger: 100,
          type: "contract",
          // Malicious payload that could cause issues if decoded
          topics: ["malicious"],
          body: { maliciousData: "should not be processed" },
        },
      ],
    };

    const mockRpcServer = {
      getEvents: vi.fn().mockResolvedValue(mockServerResponse),
    };

    const client = new SorobanRpcClient(
      "http://localhost:8000",
      [VALID_CONTRACT_A, VALID_CONTRACT_B],
      mockLogger
    );

    (client as any).server = mockRpcServer;

    const result = await client.getEvents({
      startLedger: 1,
      contractIds: [VALID_CONTRACT_A, VALID_CONTRACT_B],
    });

    // No events should be returned
    expect(result.events).toHaveLength(0);

    // Should have logged the rejection
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("allows events from all configured contract IDs", async () => {
    const mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const mockServerResponse = {
      latestLedger: 100,
      cursor: undefined,
      events: [
        {
          contractId: VALID_CONTRACT_A,
          ledger: 99,
          type: "contract",
        },
        {
          contractId: VALID_CONTRACT_B,
          ledger: 100,
          type: "contract",
        },
      ],
    };

    const mockRpcServer = {
      getEvents: vi.fn().mockResolvedValue(mockServerResponse),
    };

    const client = new SorobanRpcClient(
      "http://localhost:8000",
      [VALID_CONTRACT_A, VALID_CONTRACT_B],
      mockLogger
    );

    (client as any).server = mockRpcServer;

    const result = await client.getEvents({
      startLedger: 1,
      contractIds: [VALID_CONTRACT_A, VALID_CONTRACT_B],
    });

    // Both events should be included
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.contractId)).toEqual([
      VALID_CONTRACT_A,
      VALID_CONTRACT_B,
    ]);

    // No warnings should be logged
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
