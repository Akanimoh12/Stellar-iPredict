import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config
vi.mock("./config/index.js", () => {
  return {
    config: {
      DATABASE_URL: "postgres://localhost:5432/db",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      MARKET_CONTRACT_ID: "CC123",
      START_LEDGER: 100,
      EVENTS_PER_PAGE: 10,
      POLL_INTERVAL_MS: 10,
    },
  };
});

// Mock backfill operations
import { runBackfill } from "./backfill.js";
vi.mock("./backfill.js", () => {
  return {
    runBackfill: vi.fn().mockResolvedValue(125),
    writeEventToDb: vi.fn(),
  };
});

// Create mock server methods
const mockGetLatestLedger = vi.fn().mockResolvedValue({ sequence: 100 });
const mockGetEvents = vi.fn().mockResolvedValue({ events: [] });

vi.mock("@stellar/stellar-sdk", () => {
  const mockServer = vi.fn().mockImplementation(() => {
    return {
      getLatestLedger: mockGetLatestLedger,
      getEvents: mockGetEvents,
    };
  });
  return {
    scValToNative: vi.fn((val) => val),
    rpc: {
      Server: mockServer,
    },
  };
});

describe("Entrypoint Routing & Polling", () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it("15. Entrypoint: Correctly routes to backfill mode when --backfill flag is provided", async () => {
    process.argv = [...originalArgv, "--backfill"];

    const indexModule = await import("./index.js");

    await indexModule.main();

    expect(runBackfill).toHaveBeenCalled();
  });

  it("16. Entrypoint: Correctly routes to live polling loop when --backfill flag is omitted", async () => {
    process.argv = originalArgv.filter((arg) => arg !== "--backfill");

    const indexModule = await import("./index.js");

    await indexModule.main();

    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("17. Polling: Executes event fetching and processing in startLivePolling", async () => {
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 105 });
    mockGetEvents.mockResolvedValueOnce({
      events: [
        {
          ledger: 101,
          txHash: "hash123",
          topic: ["bet_placed", 1, "user1"],
          value: { amount: 10, is_yes: true },
        },
      ],
      latestLedger: 105,
    });

    const indexModule = await import("./index.js");
    await indexModule.startLivePolling(100);

    expect(mockGetLatestLedger).toHaveBeenCalled();
    expect(mockGetEvents).toHaveBeenCalled();
  });

  it("18. Polling: Handles errors gracefully in startLivePolling", async () => {
    mockGetLatestLedger.mockRejectedValueOnce(new Error("RPC Error"));

    const indexModule = await import("./index.js");
    await indexModule.startLivePolling(100);

    expect(mockGetLatestLedger).toHaveBeenCalled();
  });
});
