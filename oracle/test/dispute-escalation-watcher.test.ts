import { describe, expect, it } from "vitest";
import {
  detectDisputeEscalations,
  DisputeEscalationWatcher,
  type DisputeEscalationRecord,
} from "../src/aggregator/dispute-escalation-watcher.js";

function record(overrides: Partial<DisputeEscalationRecord> = {}): DisputeEscalationRecord {
  return {
    marketId: "42",
    submitter: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM",
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H",
    outcome: "yes",
    totalBond: 300_0000000n,
    escalatedAt: new Date("2026-07-01T00:00:00Z"),
    councilDeadline: new Date("2026-07-04T00:00:00Z"),
    ...overrides,
  };
}

describe("detectDisputeEscalations", () => {
  it("surfaces only escalations newer than the watermark", () => {
    const since = new Date("2026-07-01T00:00:00Z");
    const disputes = [
      record({ marketId: "1", escalatedAt: new Date("2026-06-30T00:00:00Z") }), // before watermark
      record({ marketId: "2", escalatedAt: new Date("2026-07-02T00:00:00Z") }), // after
      record({ marketId: "3", escalatedAt: new Date("2026-07-03T00:00:00Z") }), // after
    ];
    const { alerts, watermark } = detectDisputeEscalations(disputes, since);
    expect(alerts.map((a) => a.marketId)).toEqual(["2", "3"]);
    expect(watermark).toEqual(new Date("2026-07-03T00:00:00Z"));
  });

  it("returns no alerts and an unchanged watermark when nothing is new", () => {
    const since = new Date("2026-07-05T00:00:00Z");
    const disputes = [record({ escalatedAt: new Date("2026-07-01T00:00:00Z") })];
    const { alerts, watermark } = detectDisputeEscalations(disputes, since);
    expect(alerts).toHaveLength(0);
    expect(watermark).toEqual(since);
  });

  it("never surfaces the same escalation twice across repeated calls", () => {
    const disputes = [
      record({ marketId: "1", escalatedAt: new Date("2026-07-01T00:00:00Z") }),
      record({ marketId: "2", escalatedAt: new Date("2026-07-02T00:00:00Z") }),
    ];

    const first = detectDisputeEscalations(disputes, new Date(0));
    expect(first.alerts.map((a) => a.marketId)).toEqual(["1", "2"]);

    // Same rows replayed with the watermark carried forward — no
    // double-alerting even though the underlying rows are identical.
    const second = detectDisputeEscalations(disputes, first.watermark);
    expect(second.alerts).toHaveLength(0);
  });

  it("invokes onAlert exactly once per newly escalated dispute", () => {
    const seen: string[] = [];
    const disputes = [record({ marketId: "5", escalatedAt: new Date("2026-07-05T00:00:00Z") })];
    detectDisputeEscalations(disputes, new Date(0), { onAlert: (alert) => seen.push(alert.marketId) });
    expect(seen).toEqual(["5"]);
  });

  it("advances the watermark to the latest escalatedAt even out of order", () => {
    const disputes = [
      record({ marketId: "3", escalatedAt: new Date("2026-07-03T00:00:00Z") }),
      record({ marketId: "2", escalatedAt: new Date("2026-07-02T00:00:00Z") }),
    ];
    const { watermark } = detectDisputeEscalations(disputes, new Date("2026-07-01T00:00:00Z"));
    expect(watermark).toEqual(new Date("2026-07-03T00:00:00Z"));
  });
});

describe("DisputeEscalationWatcher", () => {
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

  it("surfaces new escalations and queries only rows past its watermark", async () => {
    const { pool, calls } = poolReturning([
      {
        market_id: "1",
        submitter: "GA",
        challenger: "GB",
        outcome: "yes",
        total_bond: "3000000000",
        escalated_at: "2026-07-01T00:00:00Z",
        council_deadline: "2026-07-04T00:00:00Z",
      },
    ]);
    const watcher = new DisputeEscalationWatcher(pool);

    const alerts = await watcher.poll();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].marketId).toBe("1");
    expect(calls[0]).toEqual([new Date(0).toISOString()]);
    expect(watcher.watermark).toEqual(new Date("2026-07-01T00:00:00Z"));
  });

  it("is idempotent across polls — an escalation already surfaced is not returned again", async () => {
    const rows = [
      {
        market_id: "1",
        submitter: "GA",
        challenger: "GB",
        outcome: "yes",
        total_bond: "3000000000",
        escalated_at: "2026-07-01T00:00:00Z",
        council_deadline: "2026-07-04T00:00:00Z",
      },
    ];
    const { pool, calls } = poolReturning(rows);
    const watcher = new DisputeEscalationWatcher(pool);

    const firstPoll = await watcher.poll();
    expect(firstPoll).toHaveLength(1);

    // Second poll should query with the advanced watermark; simulate the DB
    // (correctly) returning no rows past that point.
    pool.query = async (_text: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return { rows: [] };
    };
    const secondPoll = await watcher.poll();

    expect(secondPoll).toHaveLength(0);
    expect(calls[1]).toEqual([new Date("2026-07-01T00:00:00Z").toISOString()]);
  });

  it("starts from a supplied watermark", async () => {
    const { pool, calls } = poolReturning([]);
    const startingWatermark = new Date("2026-06-01T00:00:00Z");
    const watcher = new DisputeEscalationWatcher(pool, {}, startingWatermark);

    await watcher.poll();

    expect(calls[0]).toEqual([startingWatermark.toISOString()]);
    expect(watcher.watermark).toEqual(startingWatermark);
  });
});
