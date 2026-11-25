import { describe, expect, it } from "vitest";
import {
  detectNewSubmissions,
  SubmissionWatcher,
  type SubmissionRecord,
} from "../src/aggregator/submission-watcher.js";

function record(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    id: 1,
    marketId: "42",
    submitter: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM",
    outcome: "yes",
    bondAmount: 100_0000000n,
    submittedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("detectNewSubmissions", () => {
  it("surfaces only submissions newer than the watermark", () => {
    const submissions = [record({ id: 1, marketId: "1" }), record({ id: 2, marketId: "2" }), record({ id: 3, marketId: "3" })];
    const { alerts, watermark } = detectNewSubmissions(submissions, 1);
    expect(alerts.map((a) => a.marketId)).toEqual(["2", "3"]);
    expect(watermark).toBe(3);
  });

  it("returns no alerts and an unchanged watermark when nothing is new", () => {
    const submissions = [record({ id: 1 }), record({ id: 2 })];
    const { alerts, watermark } = detectNewSubmissions(submissions, 2);
    expect(alerts).toHaveLength(0);
    expect(watermark).toBe(2);
  });

  it("never surfaces the same submission twice across repeated calls", () => {
    const submissions = [record({ id: 1, marketId: "1" }), record({ id: 2, marketId: "2" })];

    const first = detectNewSubmissions(submissions, 0);
    expect(first.alerts.map((a) => a.marketId)).toEqual(["1", "2"]);

    // Same submissions replayed with the watermark carried forward — no
    // double-surfacing even though the underlying rows are identical.
    const second = detectNewSubmissions(submissions, first.watermark);
    expect(second.alerts).toHaveLength(0);
  });

  it("invokes onAlert exactly once per newly surfaced submission", () => {
    const seen: string[] = [];
    const submissions = [record({ id: 5, marketId: "5" })];
    detectNewSubmissions(submissions, 0, { onAlert: (alert) => seen.push(alert.marketId) });
    expect(seen).toEqual(["5"]);
  });

  it("advances the watermark to the highest id even out of order", () => {
    const submissions = [record({ id: 3, marketId: "3" }), record({ id: 2, marketId: "2" })];
    const { watermark } = detectNewSubmissions(submissions, 1);
    expect(watermark).toBe(3);
  });
});

describe("SubmissionWatcher", () => {
  function poolReturning(rows: Array<Record<string, unknown>>) {
    const calls: unknown[][] = [];
    return {
      calls,
      pool: {
        async query(_text: string, params?: unknown[]) {
          calls.push(params ?? []);
          return { rows };
        },
      },
    };
  }

  it("surfaces new rows and queries only ids past its watermark", async () => {
    const { pool, calls } = poolReturning([
      { id: 1, market_id: "1", submitter: "GA", outcome: "yes", bond_amount: "1000000000", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const watcher = new SubmissionWatcher(pool);

    const alerts = await watcher.poll();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].marketId).toBe("1");
    expect(calls[0]).toEqual([0]);
    expect(watcher.watermark).toBe(1);
  });

  it("is idempotent across polls — a submission already surfaced is not returned again", async () => {
    const rows = [
      { id: 1, market_id: "1", submitter: "GA", outcome: "yes", bond_amount: "1000000000", submitted_at: "2026-07-01T00:00:00Z" },
    ];
    const { pool, calls } = poolReturning(rows);
    const watcher = new SubmissionWatcher(pool);

    const firstPoll = await watcher.poll();
    expect(firstPoll).toHaveLength(1);

    // Second poll should query with the advanced watermark; simulate the DB
    // (correctly) returning no rows for `id > 1`.
    pool.query = async (_text: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return { rows: [] };
    };
    const secondPoll = await watcher.poll();

    expect(secondPoll).toHaveLength(0);
    expect(calls[1]).toEqual([1]);
  });

  it("starts from a supplied watermark", async () => {
    const { pool, calls } = poolReturning([]);
    const watcher = new SubmissionWatcher(pool, {}, 10);

    await watcher.poll();

    expect(calls[0]).toEqual([10]);
    expect(watcher.watermark).toBe(10);
  });
});
