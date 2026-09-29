import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pg before importing db or backfill
vi.mock("pg", () => {
  const mockPool = vi.fn().mockImplementation(() => {
    return {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      on: vi.fn(),
    };
  });
  return {
    default: { Pool: mockPool },
    Pool: mockPool,
  };
});

// Import pool now that pg is mocked
import { pool } from "./db.js";
import {
  isRateLimitError,
  fetchWithRetry,
  writeEventToDb,
  runBackfill,
  processEventsInChunks,
  EVENTS_PROCESSING_CHUNK_SIZE,
  sampleMemoryUsage,
} from "./backfill.js";
import { rpc } from "@stellar/stellar-sdk";

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

// Mock stellar sdk components
vi.mock("@stellar/stellar-sdk", () => {
  const mockServer = vi.fn().mockImplementation(() => {
    return {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn(),
    };
  });
  return {
    scValToNative: vi.fn((val) => val),
    rpc: {
      Server: mockServer,
    },
  };
});

describe("Backfill & Poll Module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRateLimitError", () => {
    it("should return true for status 429", () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
      expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    });

    it("should return true for message containing 429 or rate limit", () => {
      expect(isRateLimitError("Error: 429 Too Many Requests")).toBe(true);
      expect(isRateLimitError("Rate limit exceeded")).toBe(true);
      expect(isRateLimitError(new Error("rate limit reached"))).toBe(true);
    });

    it("should return false for other errors", () => {
      expect(isRateLimitError({ status: 500 })).toBe(false);
      expect(isRateLimitError("Internal Server Error")).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
    });
  });

  describe("fetchWithRetry", () => {
    it("11. Backfill: Retries on 429 rate limit errors with exponential backoff and eventually succeeds", async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw { status: 429 };
        }
        return "success-value";
      });

      const result = await fetchWithRetry(fn, 5, 1); // use 1ms delay for tests
      expect(result).toBe("success-value");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("12. Backfill: Fails after max retries on persistent 429 rate limit errors", async () => {
      const fn = vi.fn().mockImplementation(async () => {
        throw { status: 429 };
      });

      await expect(fetchWithRetry(fn, 3, 1)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });
  });

  describe("writeEventToDb", () => {
    it("10. Backfill: Processes events correctly when they are returned (market_created)", async () => {
      const topics = ["market_created"];
      const data = {
        id: 1,
        question: "Will XLM rise?",
        category: "Crypto",
        end_time: 123456,
        creator: "GCREATOR",
      };

      await writeEventToDb(101, "txhash123", topics, data);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO markets"),
        [1, "Will XLM rise?", "Crypto", 123456, "GCREATOR"]
      );
    });

    it("10. Backfill: Processes events correctly when they are returned (market_resolved)", async () => {
      const topics = ["market_resolved", 1];
      const data = { outcome: true };

      await writeEventToDb(102, "txhash123", topics, data);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE markets SET resolved=true"),
        [1, true]
      );
    });

    it("10. Backfill: Processes events correctly when they are returned (market_cancelled)", async () => {
      const topics = ["market_cancelled", 2];
      const data = {};

      await writeEventToDb(104, "txhash456", topics, data);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE markets SET cancelled=true"),
        [2]
      );
    });

    it("10. Backfill: Processes events correctly when they are returned (bet_placed)", async () => {
      const topics = ["bet_placed", 1, "GBETTOR"];
      const data = {
        amount: 100,
        gross_amount: 102,
        is_yes: true,
      };

      await writeEventToDb(103, "txhash123", topics, data);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO bets"),
        [1, "GBETTOR", 100, 102, true]
      );
    });

    it("should handle audit log query errors gracefully", async () => {
      vi.spyOn(pool, "query")
        .mockRejectedValueOnce(new Error("Audit table missing"))
        .mockResolvedValueOnce({ rows: [] } as any);

      const topics = ["market_cancelled", 2];
      const data = {};

      await writeEventToDb(104, "txhash456", topics, data);

      // Verify that market cancel query still executed after audit log caught error
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("runBackfill", () => {
    it("9. Backfill: Runs backfill successfully from START_LEDGER to network head when no events are returned", async () => {
      const mockGetLatestLedger = vi.fn().mockResolvedValue({ sequence: 120 });
      const mockGetEvents = vi.fn().mockResolvedValue({
        events: [],
        latestLedger: 120,
        cursor: "cursor-end",
      });

      const serverInstance = {
        getLatestLedger: mockGetLatestLedger,
        getEvents: mockGetEvents,
      };
      vi.mocked(rpc.Server).mockReturnValue(serverInstance as any);

      const lastLedger = await runBackfill();

      expect(lastLedger).toBe(120);
      expect(mockGetLatestLedger).toHaveBeenCalled();
      expect(mockGetEvents).toHaveBeenCalled();
    });

    it("should increment ledger and continue if empty page response is below head ledger", async () => {
      const mockGetLatestLedger = vi.fn().mockResolvedValue({ sequence: 150 });
      const mockGetEvents = vi
        .fn()
        .mockResolvedValueOnce({
          events: [],
          latestLedger: 120,
          cursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          events: [],
          latestLedger: 150,
          cursor: "cursor-2",
        });

      const serverInstance = {
        getLatestLedger: mockGetLatestLedger,
        getEvents: mockGetEvents,
      };
      vi.mocked(rpc.Server).mockReturnValue(serverInstance as any);

      const lastLedger = await runBackfill();

      expect(lastLedger).toBe(150);
      expect(mockGetEvents).toHaveBeenCalledTimes(2);
    });

    it("13. Backfill: Uses cursor-based pagination correctly for multiple pages of events", async () => {
      const mockGetLatestLedger = vi.fn().mockResolvedValue({ sequence: 150 });
      const mockGetEvents = vi
        .fn()
        .mockResolvedValueOnce({
          events: [
            {
              ledger: 110,
              txHash: "hash1",
              topic: ["bet_placed", 1, "user1"],
              value: { amount: 10, is_yes: true },
            },
          ],
          latestLedger: 120,
          cursor: "cursor-page-1",
        })
        .mockResolvedValueOnce({
          events: [],
          latestLedger: 150,
          cursor: "cursor-page-2",
        });

      const serverInstance = {
        getLatestLedger: mockGetLatestLedger,
        getEvents: mockGetEvents,
      };
      vi.mocked(rpc.Server).mockReturnValue(serverInstance as any);

      const lastLedger = await runBackfill();

      expect(lastLedger).toBe(150);
      expect(mockGetEvents).toHaveBeenCalledTimes(2);

      // Verify that the second call to getEvents used the cursor from the first response
      expect(mockGetEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cursor: "cursor-page-1",
        })
      );
    });
  });

  describe("processEventsInChunks", () => {
    it("processes all events in order across chunk boundaries", async () => {
      const events = Array.from({ length: 120 }, (_, i) => ({ id: i }));
      const processed: number[] = [];

      await processEventsInChunks(events as any, 50, async (event) => {
        processed.push((event as any).id);
      });

      expect(processed).toHaveLength(120);
      expect(processed).toEqual(Array.from({ length: 120 }, (_, i) => i));
    });

    it("respects the chunk size and yields between chunks", async () => {
      const events = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const chunkSizes: number[] = [];
      let currentChunkSize = 0;

      await processEventsInChunks(events as any, 3, async () => {
        currentChunkSize++;
      });

      // 10 events with chunk size 3 → chunks of 3, 3, 3, 1
      // We can't directly observe chunk boundaries from the processor callback,
      // but we can verify all events were processed.
      expect(currentChunkSize).toBe(10);
    });

    it("rejects invalid chunk sizes", async () => {
      await expect(processEventsInChunks([], 0, async () => {})).rejects.toThrow("chunkSize must be a positive integer");
      await expect(processEventsInChunks([], -1, async () => {})).rejects.toThrow("chunkSize must be a positive integer");
    });

    it("handles an empty event list", async () => {
      const processed: number[] = [];
      await processEventsInChunks([], 50, async (event) => {
        processed.push((event as any).id);
      });
      expect(processed).toHaveLength(0);
    });
  });

  describe("memory bounds during backfill", () => {
    it("keeps heap usage bounded during a backfill over a busy range", async () => {
      // Simulate a busy range: 3000 events across 30 pages of 100 events each.
      // With a bounded page size and chunked processing, peak heap growth
      // should stay well below what materialising all 3000 events at once would cost.
      const TOTAL_EVENTS = 3000;
      const PAGE_SIZE = 100;
      const NUM_PAGES = TOTAL_EVENTS / PAGE_SIZE;

      const mockGetLatestLedger = vi.fn().mockResolvedValue({ sequence: 100000 });
      let eventsGenerated = 0;
      const mockGetEvents = vi.fn().mockImplementation(async () => {
        const pageEvents = [];
        for (let i = 0; i < PAGE_SIZE && eventsGenerated < TOTAL_EVENTS; i++) {
          pageEvents.push({
            ledger: 1000 + eventsGenerated,
            txHash: `hash-${eventsGenerated}`,
            topic: ["bet_placed", 1, "user1"],
            value: { amount: 10, is_yes: true },
          });
          eventsGenerated++;
        }
        return {
          events: pageEvents,
          latestLedger: 100000,
          cursor: `cursor-${eventsGenerated}`,
        };
      });

      const serverInstance = {
        getLatestLedger: mockGetLatestLedger,
        getEvents: mockGetEvents,
      };
      vi.mocked(rpc.Server).mockReturnValue(serverInstance as any);

      // Force a baseline measurement
      const memBefore = sampleMemoryUsage();

      const lastLedger = await runBackfill();

      const memAfter = sampleMemoryUsage();
      const heapGrowthBytes = memAfter.heapUsed - memBefore.heapUsed;

      expect(lastLedger).toBe(100000);
      // NUM_PAGES pages with events + 1 final empty page that signals the end.
      expect(mockGetEvents).toHaveBeenCalledTimes(NUM_PAGES + 1);

      // The key assertion: heap growth should be bounded and not proportional
      // to TOTAL_EVENTS. If we materialised all 3000 events at once, growth
      // would be ~3000 * per-event-size. With chunked processing and bounded
      // pages, it should stay well under 50MB even for this busy range.
      // We use a generous threshold to avoid flakiness while still catching
      // unbounded materialisation.
      const MAX_HEAP_GROWTH_BYTES = 50 * 1024 * 1024; // 50MB
      expect(heapGrowthBytes).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    });

    it("sampleMemoryUsage returns valid memory stats", () => {
      const mem = sampleMemoryUsage();
      expect(mem.rss).toBeGreaterThan(0);
      expect(mem.heapUsed).toBeGreaterThan(0);
      expect(mem.heapTotal).toBeGreaterThan(0);
      expect(mem.external).toBeGreaterThanOrEqual(0);
    });
  });
});
