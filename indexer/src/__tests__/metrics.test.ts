import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeEventToDb } from "../event-router.js";
import { metrics, resetMetrics, Counter, Gauge } from "../metrics.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

function makeDb(): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

function makeRedis(): RedisClient {
  return {
    del: vi.fn().mockResolvedValue(1),
  };
}

const REFERRER = "G" + "A".repeat(55);

function makeEvent(topics: readonly unknown[], data: unknown): DecodedContractEvent {
  return { topics, data, ledger: 100, txHash: "tx" };
}

function marketCancelled(): DecodedContractEvent {
  return makeEvent(["mkt", "cancelled"], { market_id: 1 });
}

function referralReward(): DecodedContractEvent {
  return makeEvent(["referral", "reward"], { referrer: REFERRER, points: 3 });
}

describe("Counter", () => {
  it("starts at zero and increments by one by default", () => {
    const counter = new Counter();
    expect(counter.get()).toBe(0);
    counter.inc();
    counter.inc();
    expect(counter.get()).toBe(2);
  });

  it("increments by a positive delta and ignores non-positive deltas", () => {
    const counter = new Counter();
    counter.inc(5);
    counter.inc(0);
    counter.inc(-3);
    expect(counter.get()).toBe(5);
  });

  it("resets to zero", () => {
    const counter = new Counter();
    counter.inc(3);
    counter.reset();
    expect(counter.get()).toBe(0);
  });
});

describe("Gauge", () => {
  it("starts at zero", () => {
    const gauge = new Gauge();
    expect(gauge.get()).toBe(0);
  });

  it("can be set to any value", () => {
    const gauge = new Gauge();
    gauge.set(10);
    expect(gauge.get()).toBe(10);
    gauge.set(5);
    expect(gauge.get()).toBe(5);
    gauge.set(0);
    expect(gauge.get()).toBe(0);
  });

  it("resets to zero", () => {
    const gauge = new Gauge();
    gauge.set(42);
    gauge.reset();
    expect(gauge.get()).toBe(0);
  });
});

describe("events_processed metric", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("increments once per handled market_cancelled event", async () => {
    const db = makeDb();
    const redis = makeRedis();

    await writeEventToDb(marketCancelled(), db, redis);

    expect(metrics.eventsProcessed.get()).toBe(1);
  });

  it("increments once per handled referral_reward event", async () => {
    const db = makeDb();
    const redis = makeRedis();

    await writeEventToDb(referralReward(), db, redis);

    expect(metrics.eventsProcessed.get()).toBe(1);
  });

  it("accumulates across multiple handled events", async () => {
    const db = makeDb();
    const redis = makeRedis();

    await writeEventToDb(marketCancelled(), db, redis);
    await writeEventToDb(referralReward(), db, redis);
    await writeEventToDb(marketCancelled(), db, redis);

    expect(metrics.eventsProcessed.get()).toBe(3);
  });

  it("does not increment for unrecognised events", async () => {
    const db = makeDb();
    const redis = makeRedis();

    await writeEventToDb(makeEvent(["unknown", "event"], {}), db, redis);

    expect(metrics.eventsProcessed.get()).toBe(0);
  });
});

describe("indexer_lag metric", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("can be set to track ledger lag", () => {
    metrics.indexerLag.set(100);
    expect(metrics.indexerLag.get()).toBe(100);

    metrics.indexerLag.set(50);
    expect(metrics.indexerLag.get()).toBe(50);
  });

  it("is reset by resetMetrics", () => {
    metrics.indexerLag.set(42);
    resetMetrics();
    expect(metrics.indexerLag.get()).toBe(0);
  });
});
