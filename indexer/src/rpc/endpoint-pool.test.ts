import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { EndpointPool } from "./endpoint-pool.js";
import type { Logger } from "./endpoint-pool.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeLogger(): Logger & { warnings: string[]; infos: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    info(obj, msg) { infos.push(JSON.stringify({ ...obj, msg })); },
    warn(obj, msg) { warnings.push(JSON.stringify({ ...obj, msg })); },
    error() {},
  };
}

function latestLedgerResponse(sequence: number) {
  return { id: "1", protocolVersion: 22, sequence } as any;
}

// ── config parsing (tested via indexer/src/config) ─────────────────────────

describe("EndpointPool construction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws when no endpoints provided", () => {
    expect(() => new EndpointPool({ endpoints: [] })).toThrow(
      "EndpointPool requires at least one endpoint"
    );
  });

  it("starts with activeIndex 0", () => {
    const pool = new EndpointPool({
      endpoints: ["https://primary.example.com", "https://secondary.example.com"],
    });
    expect(pool.getActiveIndex()).toBe(0);
    pool.stop();
  });
});

// ── failover behaviour ─────────────────────────────────────────────────────

describe("EndpointPool.withFailover — failover", () => {
  afterEach(() => vi.restoreAllMocks());

  it("succeeds on first endpoint when it works", async () => {
    const spy = vi
      .spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue(latestLedgerResponse(1000));

    const pool = new EndpointPool({
      endpoints: ["https://primary.example.com", "https://secondary.example.com"],
      primaryProbeIntervalMs: 999_999,
    });

    const result = await pool.withFailover(async (srv) => srv.getLatestLedger());
    expect(result.sequence).toBe(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    pool.stop();
  });

  it("fails over to secondary when primary throws, logs the switch", async () => {
    const logger = makeLogger();

    vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(latestLedgerResponse(1001));

    const pool = new EndpointPool({
      endpoints: ["https://primary.example.com", "https://secondary.example.com"],
      logger,
      primaryProbeIntervalMs: 999_999,
    });

    const result = await pool.withFailover(async (srv) => srv.getLatestLedger());
    expect(result.sequence).toBe(1001);

    // A switch must have been logged
    const switchLog = logger.warnings.find((w) => w.includes("rpc_endpoint_switched"));
    expect(switchLog).toBeDefined();
    expect(switchLog).toContain("primary.example.com");
    expect(switchLog).toContain("secondary.example.com");

    pool.stop();
  });

  it("throws when all endpoints fail, without infinite looping", async () => {
    vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockRejectedValue(new Error("all down"));

    const pool = new EndpointPool({
      endpoints: ["https://primary.example.com", "https://secondary.example.com"],
      primaryProbeIntervalMs: 999_999,
    });

    await expect(
      pool.withFailover(async (srv) => srv.getLatestLedger())
    ).rejects.toThrow();

    pool.stop();
  });
});

// ── primary recovery ───────────────────────────────────────────────────────

describe("EndpointPool — primary recovery via probe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("switches back to primary after it recovers (fake timers)", async () => {
    vi.useFakeTimers();

    const logger = makeLogger();

    // Primary fails on first call, secondary serves, primary then recovers
    const primarySpy = vi.spyOn(rpc.Server.prototype, "getLatestLedger");
    primarySpy
      .mockRejectedValueOnce(new Error("primary down"))   // initial call → fail
      .mockResolvedValue(latestLedgerResponse(1005));      // probe + all future

    // Track which URLs are called
    const calledUrls: string[] = [];
    const pool = new EndpointPool({
      endpoints: ["https://primary.example.com", "https://secondary.example.com"],
      logger,
      primaryProbeIntervalMs: 1_000,
    });

    // First call fails over to secondary
    await pool.withFailover(async (srv, url) => {
      calledUrls.push(url);
      return srv.getLatestLedger();
    });

    expect(pool.getActiveIndex()).toBe(1); // secondary

    // Advance time to trigger probe
    await vi.advanceTimersByTimeAsync(1_100);

    // Probe fired — primary is healthy again
    expect(pool.getActiveIndex()).toBe(0); // back to primary

    // Log must include recovery message
    const recoveryLog = logger.infos.find((l) => l.includes("Primary RPC endpoint recovered"));
    expect(recoveryLog).toBeDefined();

    pool.stop();
    vi.useRealTimers();
  });
});

// ── URL redaction ──────────────────────────────────────────────────────────

describe("EndpointPool — URL redaction in logs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not log API keys or passwords in switch events", async () => {
    const logger = makeLogger();

    vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue(latestLedgerResponse(1000));

    const pool = new EndpointPool({
      endpoints: [
        "https://user:supersecret@primary.example.com",
        "https://secondary.example.com?apikey=mysecretkey",
      ],
      logger,
      primaryProbeIntervalMs: 999_999,
    });

    await pool.withFailover(async (srv) => srv.getLatestLedger());

    const allLogs = [...logger.warnings, ...logger.infos].join("\n");
    expect(allLogs).not.toContain("supersecret");
    expect(allLogs).not.toContain("mysecretkey");

    pool.stop();
  });
});
