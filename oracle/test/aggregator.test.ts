import { describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { loadAggregatorConfig } from "../src/aggregator/config.js";
import {
  createProductionDependencies,
  runAggregator,
  type AggregatorClock,
  type AggregatorDependencies,
  type AggregatorMarket,
} from "../src/aggregator/index.js";
import { createLogger } from "../src/log.js";
import { BacklogWorld, votes, type BacklogMarket } from "./fixtures/market-backlog.js";

describe("council aggregator skeleton", () => {
  it("loads and validates council configuration", () => {
    const config = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(config.COUNCIL_SIZE).toBe(7);
    expect(config.COUNCIL_THRESHOLD).toBe(4);
  });

  it("rejects a threshold larger than the council", () => {
    expect(() => loadAggregatorConfig({
      COUNCIL_SIZE: "3", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    })).toThrow("COUNCIL_THRESHOLD cannot exceed COUNCIL_SIZE");
  });

  it("rejects a threshold that is not a strict majority of the council", () => {
    expect(() => loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "3",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    })).toThrow("COUNCIL_THRESHOLD must be a strict majority (> half of COUNCIL_SIZE)");
  });

  it("rejects an exact-half threshold on an even-sized council", () => {
    expect(() => loadAggregatorConfig({
      COUNCIL_SIZE: "6", COUNCIL_THRESHOLD: "3",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    })).toThrow("COUNCIL_THRESHOLD must be a strict majority (> half of COUNCIL_SIZE)");
  });

  it("accepts a strict-majority threshold on an even-sized council", () => {
    const config = loadAggregatorConfig({
      COUNCIL_SIZE: "6", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(config.COUNCIL_SIZE).toBe(6);
    expect(config.COUNCIL_THRESHOLD).toBe(4);
  });

  it("loads optimistic oracle bond defaults", () => {
    const config = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(config.SUBMITTER_BOND_XLM).toBe(100);
    expect(config.DISPUTER_BOND_XLM).toBe(200);
  });

  it("loads optimistic oracle window defaults", () => {
    const config = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(config.CHALLENGE_WINDOW_SECONDS).toBe(86_400);
    expect(config.COUNCIL_WINDOW_SECONDS).toBe(259_200);
  });

  it("loads optimistic oracle fee default", () => {
    const config = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(config.COUNCIL_FEE_BPS).toBe(1_000);
  });

  it("allows configurable poll interval with default", () => {
    const configDefault = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(configDefault.POLL_INTERVAL_MS).toBe(5_000);

    const configCustom = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      POLL_INTERVAL_MS: "10000",
    });
    expect(configCustom.POLL_INTERVAL_MS).toBe(10_000);
  });

  it("rejects negative or zero poll interval", () => {
    expect(() => loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      POLL_INTERVAL_MS: "0",
    })).toThrow();

    expect(() => loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      POLL_INTERVAL_MS: "-1000",
    })).toThrow();
  });

  it("rejects a disputer bond that does not exceed the submitter bond", () => {
    expect(() => loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      SUBMITTER_BOND_XLM: "200",
      DISPUTER_BOND_XLM: "100",
    })).toThrow();
  });

  it("processes expired unresolved markets and closes cleanly", async () => {
    const controller = new AbortController();
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => [{ id: "42", cancelled: false }]),
      processMarket: vi.fn(async () => controller.abort()),
      close: vi.fn(async () => undefined),
    };
    await runAggregator(dependencies, { signal: controller.signal, pollIntervalMs: 1 });
    expect(dependencies.connect).toHaveBeenCalledOnce();
    expect(dependencies.processMarket).toHaveBeenCalledWith(
      { id: "42", cancelled: false },
      expect.objectContaining({ correlationId: expect.any(String) }),
    );
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("isolates one failing market from aborting the entire iteration (issue #446)", async () => {
    const controller = new AbortController();
    const processMarketMock = vi.fn(async (market) => {
      if (market.id === "bad-market") {
        throw new Error("RPC failure");
      }
      // Stop after one iteration; aborting from close() never fires, because
      // close() only runs once the loop has already exited.
      if (market.id === "market-3") controller.abort();
    });
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => [
        { id: "market-1", cancelled: false },
        { id: "bad-market", cancelled: false },
        { id: "market-3", cancelled: false },
      ]),
      processMarket: processMarketMock,
      close: vi.fn(async () => undefined),
    };

    await runAggregator(dependencies, { signal: controller.signal, pollIntervalMs: 1 });

    // All three markets should be processed despite the error
    expect(processMarketMock).toHaveBeenCalledTimes(3);
    expect(processMarketMock.mock.calls.map(([market]) => market)).toEqual([
      { id: "market-1", cancelled: false },
      { id: "bad-market", cancelled: false },
      { id: "market-3", cancelled: false },
    ]);
  });

  it("tracks consecutive failures and escalates after threshold (issue #446)", async () => {
    const controller = new AbortController();
    let iterationCount = 0;
    const alertMock = vi.fn(async () => undefined);
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => {
        iterationCount++;
        // Return the failing market 6 times to exceed threshold of 5
        if (iterationCount <= 6) {
          return [{ id: "persistent-fail", cancelled: false }];
        }
        controller.abort();
        return [];
      }),
      processMarket: vi.fn(async () => {
        throw new Error("Persistent error");
      }),
      close: vi.fn(async () => undefined),
    };

    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: 1,
      alertSender: alertMock,
    });

    // Alert should be sent for failures 5 and 6 (at/after threshold)
    expect(alertMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const alertCalls = alertMock.mock.calls.filter((call) => call[0].attempts >= 5);
    expect(alertCalls.length).toBeGreaterThan(0);
  });

  it("resets failure count on successful processing (issue #446)", async () => {
    const controller = new AbortController();
    let iterationCount = 0;
    const alertMock = vi.fn(async () => undefined);
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => {
        iterationCount++;
        if (iterationCount <= 3) {
          return [{ id: "recovery-market", cancelled: false }];
        }
        controller.abort();
        return [];
      }),
      processMarket: vi.fn(async (market) => {
        // Fail first 2 times, succeed on 3rd
        if (iterationCount <= 2) {
          throw new Error("Transient error");
        }
      }),
      close: vi.fn(async () => undefined),
    };

    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: 1,
      alertSender: alertMock,
    });

    // Should not escalate since we recover before hitting threshold
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("maintains consistent poll interval despite slow iterations (issue #448)", async () => {
    const controller = new AbortController();
    const timings: number[] = [];
    let lastIterationStart = Date.now();
    let iterationCount = 0;

    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => {
        const now = Date.now();
        if (iterationCount > 0) {
          timings.push(now - lastIterationStart);
        }
        lastIterationStart = now;
        iterationCount++;

        if (iterationCount <= 3) {
          return [{ id: "market", cancelled: false }];
        }
        controller.abort();
        return [];
      }),
      processMarket: vi.fn(async () => {
        // Simulate work that takes some time (but less than interval)
        await new Promise((resolve) => setTimeout(resolve, 50));
      }),
      close: vi.fn(async () => undefined),
    };

    const pollIntervalMs = 100;
    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs,
    });

    // All intervals should be close to pollIntervalMs (within reasonable variance)
    for (const timing of timings) {
      expect(timing).toBeGreaterThanOrEqual(pollIntervalMs - 10); // Allow small variance
      expect(timing).toBeLessThan(pollIntervalMs + 100); // But not much more
    }
  });

  it("logs overrun when iteration exceeds poll interval (issue #448)", async () => {
    const controller = new AbortController();
    const loggerMock = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() };
    loggerMock.child.mockReturnValue(loggerMock);
    let iterationCount = 0;

    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => {
        iterationCount++;
        if (iterationCount <= 1) {
          return [{ id: "market", cancelled: false }];
        }
        controller.abort();
        return [];
      }),
      processMarket: vi.fn(async () => {
        // Simulate work that exceeds the poll interval
        await new Promise((resolve) => setTimeout(resolve, 150));
      }),
      close: vi.fn(async () => undefined),
    };

    const pollIntervalMs = 100;
    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs,
      logger: loggerMock,
    });

    // Check that a warning about overrun was logged
    const warnCalls = loggerMock.warn.mock.calls.filter((call) =>
      call[0]?.includes?.("overran") || String(call[0]).includes("overran"),
    );
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it("handles abort signal during sleep gracefully (issue #448)", async () => {
    const controller = new AbortController();
    let iterationCount = 0;
    const startTime = Date.now();

    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => {
        iterationCount++;
        if (iterationCount === 1) {
          return [{ id: "market", cancelled: false }];
        }
        return [];
      }),
      processMarket: vi.fn(async () => {
        // Schedule abort during the sleep
        setTimeout(() => controller.abort(), 50);
      }),
      close: vi.fn(async () => undefined),
    };

    const pollIntervalMs = 5000; // Long interval
    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs,
    });

    const elapsedMs = Date.now() - startTime;
    // Should exit promptly (within 500ms), not wait the full 5s
    expect(elapsedMs).toBeLessThan(500);
  });

  it("loads AGGREGATOR_BATCH_SIZE configuration with default and custom value", () => {
    const configDefault = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    expect(configDefault.AGGREGATOR_BATCH_SIZE).toBe(50);

    const configCustom = loadAggregatorConfig({
      COUNCIL_SIZE: "7", COUNCIL_THRESHOLD: "4",
      DATABASE_URL: "postgres://localhost/ipredict",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      AGGREGATOR_BATCH_SIZE: "100",
    });
    expect(configCustom.AGGREGATOR_BATCH_SIZE).toBe(100);
  });

  it("queries markets in bounded batches when batchSize is configured", async () => {
    const controller = new AbortController();
    const batch1 = [{ id: "1", cancelled: false }, { id: "2", cancelled: false }];
    const batch2 = [{ id: "3", cancelled: false }];
    
    const listSpy = vi.fn(async (_now: Date, _limit?: number, after?: AggregatorMarket) => {
      if (after === undefined) return batch1;
      if (after.id === "2") return batch2;
      return [];
    });

    const processedIds: string[] = [];
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: listSpy,
      getBacklogDepth: vi.fn(async () => 3),
      processMarket: vi.fn(async (m) => {
        processedIds.push(m.id);
        if (processedIds.length === 3) controller.abort();
      }),
      close: vi.fn(async () => undefined),
    };

    await runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: 1,
      batchSize: 2,
    });

    expect(listSpy).toHaveBeenNthCalledWith(1, expect.any(Date), 2, undefined);
    // Each page resumes after the last market of the previous one.
    expect(listSpy).toHaveBeenNthCalledWith(2, expect.any(Date), 2, batch1[1]);
    expect(processedIds).toEqual(["1", "2", "3"]);
  });
});

// ---------------------------------------------------------------------------
// Simulated multi-market backlog (#468)
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 1); // virtual start of the run
const T0_S = T0 / 1_000;
const POLL_MS = 60_000;
const HOUR_S = 3_600;

/** Controllable clock: `sleep` advances virtual time instantly, never really waiting. */
function virtualClock(start: number): AggregatorClock {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function open(): Pick<BacklogMarket, "db" | "chain"> {
  return {
    db: { resolved: false, cancelled: false },
    chain: { resolved: false, cancelled: false, outcome: false },
  };
}

/** One market per state the loop has to handle, in expiry order. */
function buildBacklog(): BacklogMarket[] {
  const expired = (hoursAgo: number) => T0_S - hoursAgo * HOUR_S;
  return [
    // First in line, so everything after it proves the loop carries on past an error.
    { id: "101", scenario: "persistent RPC failure", endTime: expired(10), ...open(), votes: votes(true, 5),
      fault: { stage: "simulate", remaining: Number.POSITIVE_INFINITY, message: "rpc unavailable" } },
    { id: "102", scenario: "YES quorum", endTime: expired(9), ...open(), votes: [...votes(true, 5), ...votes(false, 1, 5)] },
    { id: "103", scenario: "NO quorum", endTime: expired(8), ...open(), votes: [...votes(false, 4), ...votes(true, 1, 4)] },
    { id: "104", scenario: "insufficient votes", endTime: expired(7), ...open(), votes: [...votes(true, 2), ...votes(false, 1, 2)] },
    { id: "105", scenario: "transient send failure", endTime: expired(6), ...open(), votes: votes(true, 4),
      fault: { stage: "send", remaining: 1, message: "503 Service Unavailable" } },
    { id: "106", scenario: "cancelled on-chain, indexer lagging", endTime: expired(5), ...open(),
      chain: { resolved: false, cancelled: true, outcome: false }, votes: votes(true, 4) },
    { id: "107", scenario: "resolved on-chain, indexer lagging", endTime: expired(4), ...open(),
      chain: { resolved: true, cancelled: false, outcome: true }, votes: votes(true, 4) },
    { id: "108", scenario: "quorum arrives after first poll", endTime: expired(3), ...open(), votes: votes(true, 3) },
    { id: "109", scenario: "cancelled in DB", endTime: expired(3), db: { resolved: false, cancelled: true },
      chain: { resolved: false, cancelled: true, outcome: false }, votes: votes(true, 4) },
    { id: "110", scenario: "resolved in DB", endTime: expired(3), db: { resolved: true, cancelled: false },
      chain: { resolved: true, cancelled: false, outcome: true }, votes: votes(true, 4) },
    // Expires between the second and third poll.
    { id: "111", scenario: "expires mid-run", endTime: T0_S + 90, ...open(), votes: votes(true, 4) },
    { id: "112", scenario: "YES quorum (filler)", endTime: expired(2), ...open(), votes: votes(true, 4) },
    { id: "113", scenario: "YES quorum (filler)", endTime: expired(2), ...open(), votes: votes(true, 7) },
    { id: "114", scenario: "NO quorum (filler)", endTime: expired(1), ...open(), votes: votes(false, 4) },
  ];
}

interface BacklogTrace {
  /** Every structured log line the run emitted, parsed. */
  lines: Array<Record<string, unknown>>;
  /** Every finalize webhook the run sent. */
  webhooks: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
}

interface BacklogRun {
  /** Market ids processMarket was called with, per iteration (1-based). */
  attempts: Map<number, string[]>;
  /** Market ids the expiry query would return at the start of each iteration. */
  eligible: Map<number, string[]>;
  alerts: Array<{ marketId: string; attempts: number; correlationId?: string }>;
}

async function runBacklog(
  world: BacklogWorld,
  iterations: number,
  betweenIterations: (completed: number) => void = () => {},
  trace?: BacklogTrace,
): Promise<BacklogRun> {
  const config = loadAggregatorConfig({
    COUNCIL_SIZE: "7",
    COUNCIL_THRESHOLD: "4",
    DATABASE_URL: "postgres://backlog.invalid/ipredict",
    SOROBAN_RPC_URL: "https://rpc.backlog.invalid",
    RESOLVER_KEY: world.resolverSecret,
    MARKET_CONTRACT_ID: world.contractId,
    NETWORK_PASSPHRASE: Networks.TESTNET,
    FINALIZE_WEBHOOK_URL: "https://hooks.backlog.invalid/finalized",
  });
  const logger = trace
    ? createLogger({ level: "debug", sink: (line) => trace.lines.push(JSON.parse(line)) })
    : createLogger({ level: "error", sink: () => {} });
  const fetchFn = (async (_url: string, init: RequestInit) => {
    trace?.webhooks.push({
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const clock = virtualClock(T0);
  const deps = createProductionDependencies(config, logger, {
    database: world.pool(),
    server: world.server(),
    fetchFn,
  });

  const run: BacklogRun = { attempts: new Map(), eligible: new Map(), alerts: [] };
  let iteration = 1;

  const list = deps.listExpiredUnresolvedMarkets.bind(deps);
  deps.listExpiredUnresolvedMarkets = async (now, ...rest) => {
    if (!run.eligible.has(iteration)) {
      run.eligible.set(iteration, world.eligibleAt(Math.floor(now.getTime() / 1_000)).map((m) => m.id));
    }
    return list(now, ...rest);
  };
  const processMarket = deps.processMarket.bind(deps);
  deps.processMarket = async (market, ...rest) => {
    run.attempts.set(iteration, [...(run.attempts.get(iteration) ?? []), market.id]);
    return processMarket(market, ...rest);
  };

  const controller = new AbortController();
  await runAggregator(deps, {
    signal: controller.signal,
    pollIntervalMs: POLL_MS,
    batchSize: 3,
    logger,
    clock,
    alertSender: async (alert) => {
      run.alerts.push({ marketId: alert.marketId, attempts: alert.attempts, correlationId: alert.correlationId });
    },
    onIterationComplete: () => {
      betweenIterations(iteration);
      if (iteration >= iterations) controller.abort();
      iteration += 1;
    },
  });
  return run;
}

describe("aggregator loop against a simulated multi-market backlog (#468)", () => {
  const ITERATIONS = 6;

  async function runScenario() {
    const world = new BacklogWorld(buildBacklog());
    const run = await runBacklog(world, ITERATIONS, (completed) => {
      // The fourth YES vote for market 108 lands after the first poll.
      if (completed === 1) world.addVotes("108", votes(true, 1, 3));
    });
    return { world, run };
  }

  const finalizedIn = (run: BacklogRun, id: string) =>
    [...run.attempts.entries()].filter(([, ids]) => ids.includes(id)).map(([n]) => n);

  it("drives every market to its correct terminal state", async () => {
    const { world } = await runScenario();

    const expectedDecisions: Record<string, string> = {
      "102": "yes", "103": "no", "105": "yes", "108": "yes",
      "111": "yes", "112": "yes", "113": "yes", "114": "no",
    };
    const decisions = Object.fromEntries([...world.finalized.values()].map((row) => [row.marketId, row.decision]));
    expect(decisions).toEqual(expectedDecisions);

    // Exactly one on-chain resolution per finalized market — no double submits.
    expect(world.transactions.map((tx) => tx.marketId).sort()).toEqual(Object.keys(expectedDecisions).sort());
    for (const [id, decision] of Object.entries(expectedDecisions)) {
      expect(world.market(id).chain, `${id} (${world.market(id).scenario})`).toMatchObject({
        resolved: true,
        outcome: decision === "yes",
      });
    }

    // The on-chain state check stops the aggregator before it ever sends a
    // resolution for a market the contract already considers closed.
    expect(world.rejected).toEqual([]);

    // Everything else is left exactly as it was.
    for (const id of ["101", "104", "106", "107", "109", "110"]) {
      expect(world.finalized.has(id), `${id} (${world.market(id).scenario})`).toBe(false);
    }
    expect(world.market("104").chain.resolved).toBe(false);
    expect(world.market("106").chain).toMatchObject({ cancelled: true, resolved: false });
  });

  it("finalizes a transiently failing market on a later iteration", async () => {
    const { world, run } = await runScenario();

    // Failed in the first poll, retried and finalized in the second, then gone.
    expect(finalizedIn(run, "105")).toEqual([1, 2]);
    expect(world.finalized.get("105")?.decision).toBe("yes");
    expect(run.alerts.some((alert) => alert.marketId === "105")).toBe(false);
  });

  it("finalizes markets whose quorum or expiry arrives mid-run", async () => {
    const { run } = await runScenario();

    expect(finalizedIn(run, "108")).toEqual([1, 2]);
    expect(finalizedIn(run, "111")).toEqual([3]);
  });

  it("escalates a persistently failing market without starving the rest", async () => {
    const { run } = await runScenario();

    expect(finalizedIn(run, "101")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(run.alerts.filter((a) => a.marketId === "101").map(({ attempts }) => attempts)).toEqual([5, 6]);
    expect(run.alerts.every((a) => a.marketId === "101")).toBe(true);
  });

  it("attempts every eligible market in every iteration, errors included", async () => {
    const { run } = await runScenario();

    expect(run.eligible.size).toBe(ITERATIONS);
    for (let n = 1; n <= ITERATIONS; n++) {
      // Markets finalized mid-iteration drop out of the query, and one fails
      // up front; neither may cause a later market to be skipped.
      expect(run.attempts.get(n) ?? [], `iteration ${n}`).toEqual(run.eligible.get(n));
    }
    // The DB-cancelled and DB-resolved markets are never touched.
    const touched = new Set([...run.attempts.values()].flat());
    expect(touched.has("109")).toBe(false);
    expect(touched.has("110")).toBe(false);
  });

  it("is deterministic across runs", async () => {
    const first = await runScenario();
    const second = await runScenario();

    expect(second.run.attempts).toEqual(first.run.attempts);
    // Correlation ids are random per attempt; everything else must repeat.
    const withoutIds = (run: BacklogRun) => run.alerts.map(({ marketId, attempts }) => ({ marketId, attempts }));
    expect(withoutIds(second.run)).toEqual(withoutIds(first.run));
    expect([...second.world.finalized.keys()]).toEqual([...first.world.finalized.keys()]);
  });
});

// ---------------------------------------------------------------------------
// Correlation ids across the finalization path (#467)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lines the loop emits outside any single market's processing. */
const LOOP_LEVEL_MESSAGES = new Set(["aggregator connected", "poll iteration complete", "aggregator stopped"]);

describe("correlation ids across the finalization path (#467)", () => {
  async function tracedRun(world = new BacklogWorld(buildBacklog()), iterations = 6) {
    const trace: BacklogTrace = { lines: [], webhooks: [] };
    const run = await runBacklog(
      world,
      iterations,
      (completed) => {
        if (completed === 1 && world.markets.has("108")) world.addVotes("108", votes(true, 1, 3));
      },
      trace,
    );
    return { world, run, trace };
  }

  it("tags every log line emitted while processing a market", async () => {
    const { trace } = await tracedRun();

    const untagged = trace.lines.filter((line) => !UUID.test(String(line.correlationId)));
    // Only the loop's own bookkeeping lines are outside a market attempt.
    expect([...new Set(untagged.map((line) => line.message))].sort()).toEqual(
      [...LOOP_LEVEL_MESSAGES].filter((m) => untagged.some((l) => l.message === m)).sort(),
    );
    expect(untagged.every((line) => line.marketId === undefined)).toBe(true);
    // And the tagged lines really are per market: one market per id.
    const marketsById = new Map<string, Set<unknown>>();
    for (const line of trace.lines.filter((l) => l.correlationId)) {
      const markets = marketsById.get(String(line.correlationId)) ?? new Set();
      markets.add(line.marketId);
      marketsById.set(String(line.correlationId), markets);
    }
    for (const [id, markets] of marketsById) expect([...markets], id).toHaveLength(1);
  });

  it("retrieves the whole story of one finalization from a single id", async () => {
    const { world, trace } = await tracedRun();

    const webhook = trace.webhooks.find((w) => w.body.marketId === "102");
    const correlationId = String(webhook?.body.correlationId);
    expect(correlationId).toMatch(UUID);

    const story = trace.lines.filter((line) => line.correlationId === correlationId);
    expect(story.map((line) => line.message)).toEqual([
      "computed tally",
      "vote tally",
      "threshold met, finalizing market",
      "persisted finalized decision",
      "Market 102 finalized",
      "market finalized",
    ]);
    expect(story.every((line) => line.marketId === "102")).toBe(true);
    // The row the attempt wrote leads back to the same story.
    expect(world.finalized.get("102")?.requestId).toBe(correlationId);
  });

  it("sends the correlation id in every webhook payload and x-request-id header", async () => {
    const { world, trace } = await tracedRun();

    expect(trace.webhooks.map((w) => w.body.marketId).sort()).toEqual([...world.finalized.keys()].sort());
    for (const { body, headers } of trace.webhooks) {
      expect(body.correlationId).toMatch(UUID);
      expect(headers["x-request-id"]).toBe(body.correlationId);
      expect(world.finalized.get(String(body.marketId))?.requestId).toBe(body.correlationId);
    }
    const ids = trace.webhooks.map((w) => w.body.correlationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives each attempt its own id, so a retry is a separate story", async () => {
    const { run, trace } = await tracedRun();

    const failure = trace.lines.find((l) => l.message === "market processing failed" && l.marketId === "105");
    const success = trace.lines.find((l) => l.message === "market finalized" && l.marketId === "105");
    expect(failure?.correlationId).toMatch(UUID);
    expect(success?.correlationId).toMatch(UUID);
    expect(failure?.correlationId).not.toBe(success?.correlationId);
    expect(failure?.error).toMatchObject({ message: "503 Service Unavailable" });

    // Escalations carry the id of the attempt that tripped them.
    const alert = run.alerts.find((a) => a.marketId === "101" && a.attempts === 5);
    expect(alert?.correlationId).toMatch(UUID);
    expect(
      trace.lines.some((l) => l.message === "market processing failed" && l.correlationId === alert?.correlationId),
    ).toBe(true);
  });

  it("joins the backend request id of an HTTP submission across the process boundary", async () => {
    const backendRequestId = "7d1f2a9e-5b4c-4e3a-9f10-2b3c4d5e6f70";
    const world = new BacklogWorld([
      { id: "201", scenario: "submitted over HTTP", endTime: T0_S - HOUR_S, ...open(), votes: votes(true, 4) },
    ]);
    // What POST /api/oracle/submit leaves behind: the market's row, stamped
    // with the backend's request id.
    world.backendSubmissions.set("201", backendRequestId);

    const { trace } = await tracedRun(world, 1);

    const joined = trace.lines.find((l) => l.message === "correlated with originating backend request");
    expect(joined).toMatchObject({ marketId: "201", originRequestId: backendRequestId });
    expect(joined?.correlationId).toMatch(UUID);
    // processMarket's later lines carry both ids, so searching for either one
    // finds them; the loop's own lines for the attempt carry the correlation id.
    const attempt = trace.lines.filter((l) => l.correlationId === joined?.correlationId);
    const fromProcessMarket = attempt.slice(attempt.indexOf(joined!)).filter((l) => l.message !== "market processing failed");
    expect(fromProcessMarket.map((l) => l.message)).toEqual([
      "correlated with originating backend request",
      "computed tally",
      "vote tally",
      "threshold met, finalizing market",
    ]);
    expect(fromProcessMarket.every((l) => l.originRequestId === backendRequestId)).toBe(true);
    expect(attempt.every((l) => l.marketId === "201")).toBe(true);
  });
});

describe("aggregator graceful shutdown drain", () => {
  it("lets the in-flight market finish after shutdown and starts no new market", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const processMarket = vi.fn(async (market: AggregatorMarket) => {
      if (market.id === "one") await inFlight;
    });
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => [
        { id: "one", cancelled: false },
        { id: "two", cancelled: false },
      ]),
      processMarket,
      close: vi.fn(async () => undefined),
    };

    const run = runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: 1,
      shutdownGraceMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await run;

    expect(processMarket).toHaveBeenCalledTimes(1);
    expect(processMarket.mock.calls[0][0]).toMatchObject({ id: "one" });
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("stops waiting after the configured shutdown grace period", async () => {
    const controller = new AbortController();
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => [{ id: "stuck", cancelled: false }]),
      processMarket: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(async () => undefined),
    };

    const run = runAggregator(dependencies, {
      signal: controller.signal,
      pollIntervalMs: 1,
      shutdownGraceMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await run;

    expect(dependencies.close).toHaveBeenCalledOnce();
  });
});
