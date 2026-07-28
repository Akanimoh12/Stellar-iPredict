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
});
