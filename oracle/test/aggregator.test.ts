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
    
    const listSpy = vi.fn(async (_now: Date, _limit?: number, offset?: number) => {
      if (offset === 0) return batch1;
      if (offset === 2) return batch2;
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

    expect(listSpy).toHaveBeenNthCalledWith(1, expect.any(Date), 2, 0);
    expect(listSpy).toHaveBeenNthCalledWith(2, expect.any(Date), 2, 2);
    expect(processedIds).toEqual(["1", "2", "3"]);
  });
});
