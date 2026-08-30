import { describe, expect, it, vi } from "vitest";
import { loadAggregatorConfig } from "../src/aggregator/config.js";
import { runAggregator, type AggregatorDependencies } from "../src/aggregator/index.js";

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
    expect(dependencies.processMarket).toHaveBeenCalledWith({ id: "42", cancelled: false });
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it("isolates one failing market from aborting the entire iteration (issue #446)", async () => {
    const controller = new AbortController();
    const processMarketMock = vi.fn(async (market) => {
      if (market.id === "bad-market") {
        throw new Error("RPC failure");
      }
    });
    const dependencies: AggregatorDependencies = {
      connect: vi.fn(async () => undefined),
      listExpiredUnresolvedMarkets: vi.fn(async () => [
        { id: "market-1", cancelled: false },
        { id: "bad-market", cancelled: false },
        { id: "market-3", cancelled: false },
      ]),
      processMarket: processMarketMock,
      close: vi.fn(async () => controller.abort()),
    };

    await runAggregator(dependencies, { signal: controller.signal, pollIntervalMs: 1 });

    // All three markets should be processed despite the error
    expect(processMarketMock).toHaveBeenCalledTimes(3);
    expect(processMarketMock).toHaveBeenCalledWith({ id: "market-1", cancelled: false });
    expect(processMarketMock).toHaveBeenCalledWith({ id: "bad-market", cancelled: false });
    expect(processMarketMock).toHaveBeenCalledWith({ id: "market-3", cancelled: false });
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
    const loggerMock = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
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
});
