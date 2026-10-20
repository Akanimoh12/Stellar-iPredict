import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BreakerSnapshot, CircuitBreakerStateStore } from "../src/adapters/circuitBreaker.js";

vi.mock("../src/aggregator/alert.js", () => ({ alertCircuitBreakerOpen: vi.fn() }));

/** A fresh module instance, as the oracle sees it after a process restart. */
async function loadBreaker() {
  vi.resetModules();
  return import("../src/adapters/circuitBreaker.js");
}

function memoryStore(initial?: BreakerSnapshot): CircuitBreakerStateStore & { saved?: BreakerSnapshot } {
  const store: CircuitBreakerStateStore & { saved?: BreakerSnapshot } = {
    saved: initial,
    load: () => (store.saved ? structuredClone(store.saved) : undefined),
    save: (snapshot) => {
      store.saved = structuredClone(snapshot);
    },
  };
  return store;
}

function openBreaker(name: string, breaker: Awaited<ReturnType<typeof loadBreaker>>): void {
  for (let i = 0; i < 10; i++) breaker.recordFailure(name);
}

describe("circuit breaker persistence", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forgets an open breaker on restart when no store is configured", async () => {
    const before = await loadBreaker();
    openBreaker("coingecko", before);
    expect(before.shouldSkip("coingecko")).toBe(true);

    const after = await loadBreaker();
    expect(after.shouldSkip("coingecko")).toBe(false);
  });

  it("keeps an open breaker open across a restart", async () => {
    const store = memoryStore();
    const before = await loadBreaker();
    before.configureCircuitBreakerPersistence(store);
    openBreaker("coingecko", before);
    expect(before.shouldSkip("coingecko")).toBe(true);

    const after = await loadBreaker();
    after.configureCircuitBreakerPersistence(store);

    expect(after.shouldSkip("coingecko")).toBe(true);
    expect(after.getBreakerStats()).toEqual([
      expect.objectContaining({ adapter: "coingecko", isOpen: true, failures: 10 }),
    ]);
  });

  it("still allows one recovery probe once the persisted probe interval has elapsed", async () => {
    const store = memoryStore({
      coingecko: { failures: 10, successes: 0, isOpen: true, lastProbeTime: Date.now() - 60_000 },
    });
    const breaker = await loadBreaker();
    breaker.configureCircuitBreakerPersistence(store);

    expect(breaker.shouldSkip("coingecko")).toBe(false);
    expect(breaker.shouldSkip("coingecko")).toBe(true);
    expect(store.saved?.coingecko.lastProbeTime).toBeGreaterThan(Date.now() - 1_000);
  });

  it("persists the breaker closing after a successful probe", async () => {
    const store = memoryStore({
      coingecko: { failures: 10, successes: 0, isOpen: true, lastProbeTime: 0 },
    });
    const breaker = await loadBreaker();
    breaker.configureCircuitBreakerPersistence(store);

    breaker.recordSuccess("coingecko");

    expect(store.saved?.coingecko).toMatchObject({ isOpen: false, failures: 0, successes: 1 });
  });

  it("skips malformed entries and survives an unreadable or failing store", async () => {
    const breaker = await loadBreaker();
    breaker.configureCircuitBreakerPersistence(
      memoryStore({
        good: { failures: 10, successes: 0, isOpen: true, lastProbeTime: Date.now() },
        bad: { failures: -1, successes: 0, isOpen: "yes", lastProbeTime: 0 } as never,
      }),
    );
    expect(breaker.getBreakerStats().map((s) => s.adapter)).toEqual(["good"]);

    breaker.configureCircuitBreakerPersistence({
      load: () => {
        throw new SyntaxError("Unexpected token");
      },
      save: () => {
        throw new Error("disk full");
      },
    });
    expect(breaker.getBreakerStats()).toEqual([]);
    expect(() => breaker.recordFailure("coingecko")).not.toThrow();
  });
});

describe("FileCircuitBreakerStateStore", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "breaker-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns undefined when nothing has been saved yet", async () => {
    const { FileCircuitBreakerStateStore } = await loadBreaker();
    expect(new FileCircuitBreakerStateStore(path.join(directory, "missing.json")).load()).toBeUndefined();
  });

  it("round-trips a snapshot, creating the parent directory", async () => {
    const { FileCircuitBreakerStateStore } = await loadBreaker();
    const file = path.join(directory, "nested", "breakers.json");
    const snapshot = { binance: { failures: 9, successes: 1, isOpen: true, lastProbeTime: 1_700_000_000_000 } };

    new FileCircuitBreakerStateStore(file).save(snapshot);

    expect(new FileCircuitBreakerStateStore(file).load()).toEqual(snapshot);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(snapshot);
  });

  it("throws on a corrupt file so the breaker can report it", async () => {
    const { FileCircuitBreakerStateStore } = await loadBreaker();
    const file = path.join(directory, "breakers.json");
    writeFileSync(file, "{not json");
    expect(() => new FileCircuitBreakerStateStore(file).load()).toThrow(SyntaxError);
  });
});
