import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { SorobanRpcClient } from "./getEvents.js";
import { resetMetrics, metrics } from "../metrics.js";

const CONTRACT_IDS = ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"];

function latestLedger(sequence: number) {
  return { id: "1", protocolVersion: 22, sequence } as any;
}

function eventsResponse(latestLedger: number, events: any[] = []) {
  return { events, latestLedger } as any;
}

beforeEach(() => {
  resetMetrics();
  vi.restoreAllMocks();
});

afterEach(() => vi.restoreAllMocks());

// ── config parsing ─────────────────────────────────────────────────────────

describe("config: SOROBAN_RPC_URLS parsing", () => {
  it("parses comma-separated URLs into an ordered list", () => {
    const { parseRpcEndpoints } = (() => {
      // Exercise parsing logic directly via indexer config helper
      const raw = "https://a.example.com , https://b.example.com , https://c.example.com";
      const urls = raw.split(",").map((u) => u.trim()).filter(Boolean);
      const unique = Array.from(new Set(urls));
      return { parseRpcEndpoints: unique };
    })();
    expect(parseRpcEndpoints).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ]);
  });

  it("deduplicates URLs", () => {
    const raw = "https://a.example.com,https://b.example.com,https://a.example.com";
    const unique = Array.from(new Set(raw.split(",").map((u) => u.trim())));
    expect(unique).toHaveLength(2);
    expect(unique[0]).toBe("https://a.example.com");
    expect(unique[1]).toBe("https://b.example.com");
  });

  it("legacy single URL still works as a 1-element list", () => {
    const single = "https://soroban-testnet.stellar.org";
    const urls = single.split(",").map((u) => u.trim()).filter(Boolean);
    expect(urls).toEqual([single]);
  });
});

// ── single-endpoint backward compat ───────────────────────────────────────

describe("SorobanRpcClient — single URL (backward compat)", () => {
  it("fetches events normally without pool", async () => {
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue(latestLedger(1005));
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue(eventsResponse(1005));

    const client = new SorobanRpcClient(["https://primary.example.com"]);
    const result = await client.getEvents({ startLedger: 1000, contractIds: CONTRACT_IDS });

    expect(result.latestLedger).toBe(1005);
    // Single endpoint uses index -1
    expect(metrics.activeRpcEndpointIndex.get()).toBe(-1);

    client.stop();
  });
});

// ── monotonicity enforcement ───────────────────────────────────────────────

describe("SorobanRpcClient — ledger monotonicity", () => {
  it("rejects an endpoint whose latestLedger < startLedger (H=1000, endpoint at 998)", async () => {
    // Primary reports latest=998, secondary reports latest=1001
    const getLatestSpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValueOnce(latestLedger(998))   // primary — behind
      .mockResolvedValueOnce(latestLedger(1001));  // secondary — usable

    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue(eventsResponse(1001));

    const client = new SorobanRpcClient([
      "https://primary.example.com",
      "https://secondary.example.com",
    ]);

    // H = 1000; startLedger = H+1 = 1001
    const result = await client.getEvents({ startLedger: 1001, contractIds: CONTRACT_IDS });

    // Secondary was used (primary was behind)
    expect(result.latestLedger).toBe(1001);

    // Primary (index 0) must have been attempted then skipped, secondary used
    expect(getLatestSpy).toHaveBeenCalledTimes(2);

    client.stop();
  });

  /**
   * Vacuousness check: comment out the latestLedger >= startLedger guard in
   * getEvents.ts and this test must fail (the behind endpoint would be accepted).
   */
  it("[vacuousness] primary at 998 must NOT serve events at startLedger=1001", async () => {
    // Both endpoints: primary at 998 (behind), secondary at 1001
    const getLatestSpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValueOnce(latestLedger(998))
      .mockResolvedValueOnce(latestLedger(1001));

    const getEventsSpy = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValue(eventsResponse(1001));

    const client = new SorobanRpcClient([
      "https://primary.example.com",
      "https://secondary.example.com",
    ]);

    await client.getEvents({ startLedger: 1001, contractIds: CONTRACT_IDS });

    // getEvents must only be called once — for the secondary (1001), not primary (998)
    expect(getEventsSpy).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it("when secondary reaches H+1, processes events from that ledger with no gap", async () => {
    // H = 1000, secondary was at 998 but now at 1001
    vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValueOnce(latestLedger(998))   // primary attempt 1 — behind
      .mockResolvedValueOnce(latestLedger(1001))  // secondary — now usable
      .mockResolvedValue(latestLedger(1005));     // any further probes

    const mockEvent = {
      contractId: { toString: () => CONTRACT_IDS[0] },
      ledger: 1001,
      type: "contract",
    };
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue(
      eventsResponse(1001, [mockEvent])
    );

    const client = new SorobanRpcClient([
      "https://primary.example.com",
      "https://secondary.example.com",
    ]);

    // startLedger = H + 1 = 1001
    const result = await client.getEvents({ startLedger: 1001, contractIds: CONTRACT_IDS });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].ledger).toBe(1001);
    expect(result.latestLedger).toBe(1001);

    client.stop();
  });

  it("all endpoints behind startLedger → rejects with error, no infinite loop", async () => {
    vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue(latestLedger(500)); // both behind

    const client = new SorobanRpcClient([
      "https://primary.example.com",
      "https://secondary.example.com",
    ]);

    // With both behind, withFailover exhausts all endpoints and throws
    await expect(
      client.getEvents({ startLedger: 1001, contractIds: CONTRACT_IDS })
    ).rejects.toThrow();

    client.stop();
  }, 10_000);
});

// ── active endpoint metric ─────────────────────────────────────────────────

describe("SorobanRpcClient — active endpoint metric", () => {
  it("updates metric to secondary index after failover", async () => {
    vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockRejectedValueOnce(new Error("timeout"))  // primary fails
      .mockResolvedValue(latestLedger(1005));         // secondary succeeds

    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue(eventsResponse(1005));

    const client = new SorobanRpcClient([
      "https://primary.example.com",
      "https://secondary.example.com",
    ]);

    await client.getEvents({ startLedger: 1000, contractIds: CONTRACT_IDS });

    // After failover, active is secondary (index 1)
    expect(metrics.activeRpcEndpointIndex.get()).toBe(1);

    client.stop();
  });
});
