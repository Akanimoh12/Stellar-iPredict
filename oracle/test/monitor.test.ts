import { describe, expect, it, vi } from "vitest";
import type { QueryablePool } from "../src/aggregator/tally.js";
import { createLogger } from "../src/log.js";
import {
  createAlertEmitter,
  createMonitorWatchers,
  listExpiredUnresolvedMarkets,
  loadMonitorConfig,
  readWatermarks,
  runMonitor,
  runMonitorCycle,
  serializeAlert,
  totalAlerts,
  xlmToStroops,
  type Alert,
  type MonitorCycleDependencies,
} from "../src/monitor/index.js";

const HOUR = 60 * 60 * 1_000;
const NOW = new Date("2026-01-10T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

type Row = Record<string, unknown>;

/**
 * Routes each query to a canned result by matching the table it reads, so a
 * test only has to declare the rows it cares about.
 */
function fakePool(tables: Partial<Record<string, Row[]>> = {}): QueryablePool & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query<T extends Row = Row>(text: string): Promise<{ rows: T[] }> {
      calls.push(text);
      if (/FROM markets/.test(text)) return { rows: (tables.markets ?? []) as T[] };
      if (/MAX\(id\) AS max_id/.test(text)) return { rows: (tables.submissionWatermark ?? [{ max_id: null }]) as T[] };
      if (/MAX\(escalated_at\)/.test(text)) return { rows: (tables.disputeWatermark ?? [{ max_escalated_at: null }]) as T[] };
      if (/FROM oracle_disputes/.test(text)) return { rows: (tables.disputes ?? []) as T[] };
      if (/bond_amount, status/.test(text)) return { rows: (tables.bonds ?? []) as T[] };
      // Checked before the bare `oracle_submissions` match: the council
      // queries join the two tables and would otherwise be routed to it.
      if (/council_votes/.test(text)) return { rows: (tables.escalated ?? []) as T[] };
      if (/FROM oracle_submissions/.test(text)) return { rows: (tables.submissions ?? []) as T[] };
      return { rows: [] as T[] };
    },
  };
}

function deps(
  pool: QueryablePool,
  emit: MonitorCycleDependencies["emit"],
): MonitorCycleDependencies {
  return {
    pool,
    emit,
    ...createMonitorWatchers(pool, { submissionId: 0, escalatedAt: new Date(0) }),
  };
}

const baseConfig = loadMonitorConfig({
  DATABASE_URL: "postgres://ipredict:ipredict@localhost:5432/ipredict",
});

describe("loadMonitorConfig", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadMonitorConfig({})).toThrow();
  });

  it("applies documented defaults", () => {
    expect(baseConfig.MONITOR_INTERVAL_MS).toBe(60_000);
    expect(baseConfig.STUCK_MARKET_HOURS).toBe(6);
    expect(baseConfig.COUNCIL_INACTIVITY_HOURS).toBe(48);
    expect(baseConfig.SUBMITTER_BOND_XLM).toBe(100);
    expect(baseConfig.ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it("coerces numeric env strings and rejects a non-URL webhook", () => {
    const config = loadMonitorConfig({
      DATABASE_URL: "postgres://localhost/ipredict",
      MONITOR_INTERVAL_MS: "15000",
      STUCK_MARKET_HOURS: "2.5",
    });
    expect(config.MONITOR_INTERVAL_MS).toBe(15_000);
    expect(config.STUCK_MARKET_HOURS).toBe(2.5);
    expect(() =>
      loadMonitorConfig({ DATABASE_URL: "postgres://localhost/ipredict", ALERT_WEBHOOK_URL: "nope" }),
    ).toThrow();
  });
});

describe("xlmToStroops", () => {
  it("converts the documented 100 XLM minimum bond to stroops", () => {
    expect(xlmToStroops(100)).toBe(1_000_000_000n);
    expect(xlmToStroops(0.5)).toBe(5_000_000n);
  });
});

describe("serializeAlert", () => {
  it("renders bigint bonds as strings instead of throwing", () => {
    const alert: Alert = {
      type: "oracle.monitor.bond_below_minimum",
      payload: { marketId: "7", currentBond: 1n, requiredMinimum: 1_000_000_000n },
    };
    expect(JSON.parse(serializeAlert(alert))).toEqual({
      type: "oracle.monitor.bond_below_minimum",
      marketId: "7",
      currentBond: "1",
      requiredMinimum: "1000000000",
    });
  });
});

describe("createAlertEmitter", () => {
  function silentLogger() {
    const lines: string[] = [];
    return { logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }), lines };
  }

  it("logs the alert and POSTs it when a webhook is configured", async () => {
    const { logger, lines } = silentLogger();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const emit = createAlertEmitter("https://alerts.example/hook", logger, fetchImpl as unknown as typeof fetch);

    await emit({ type: "oracle.monitor.market_stuck", payload: { marketId: "3" } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://alerts.example/hook");
    expect(JSON.parse(String(init.body))).toMatchObject({ type: "oracle.monitor.market_stuck", marketId: "3" });
    expect(lines.some((line) => line.includes("oracle.monitor.market_stuck"))).toBe(true);
  });

  it("still logs when no webhook is configured", async () => {
    const { logger, lines } = silentLogger();
    const fetchImpl = vi.fn();
    const emit = createAlertEmitter(undefined, logger, fetchImpl as unknown as typeof fetch);

    await emit({ type: "oracle.monitor.market_stuck", payload: { marketId: "3" } });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });

  it("swallows a webhook failure so one bad hook cannot stop monitoring", async () => {
    const { logger, lines } = silentLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const emit = createAlertEmitter("https://alerts.example/hook", logger, fetchImpl as unknown as typeof fetch);

    await expect(
      emit({ type: "oracle.monitor.dispute_escalated", payload: { marketId: "9" } }),
    ).resolves.toBeUndefined();
    expect(lines.some((line) => line.includes("failed to deliver alert webhook"))).toBe(true);
  });

  it("logs a non-2xx webhook response", async () => {
    const { logger, lines } = silentLogger();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const emit = createAlertEmitter("https://alerts.example/hook", logger, fetchImpl as unknown as typeof fetch);

    await emit({ type: "oracle.monitor.council_inactive", payload: { marketId: "9" } });
    expect(lines.some((line) => line.includes("non-2xx"))).toBe(true);
  });
});

describe("listExpiredUnresolvedMarkets", () => {
  it("maps rows and passes the cutoff to SQL", async () => {
    const pool = fakePool({
      markets: [{ id: "1", end_time: "1700000000", cancelled: false }],
    });
    await expect(listExpiredUnresolvedMarkets(pool, NOW_SECONDS)).resolves.toEqual([
      { id: "1", endTime: 1_700_000_000, cancelled: false },
    ]);
    expect(pool.calls[0]).toContain("end_time <= $1");
  });
});

describe("readWatermarks", () => {
  it("returns zeroed marks for an empty database", async () => {
    await expect(readWatermarks(fakePool())).resolves.toEqual({
      submissionId: 0,
      escalatedAt: new Date(0),
    });
  });

  it("returns the current maxima so a restart does not replay history", async () => {
    const pool = fakePool({
      submissionWatermark: [{ max_id: "42" }],
      disputeWatermark: [{ max_escalated_at: "2026-01-09T00:00:00.000Z" }],
    });
    await expect(readWatermarks(pool)).resolves.toEqual({
      submissionId: 42,
      escalatedAt: new Date("2026-01-09T00:00:00.000Z"),
    });
  });
});

describe("runMonitorCycle", () => {
  it("reports zero alerts on a healthy stack", async () => {
    const emit = vi.fn(async () => {});
    const result = await runMonitorCycle(deps(fakePool(), emit), baseConfig, NOW);

    expect(totalAlerts(result)).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("alerts on a market stuck past the configured window, but not on a cancelled one", async () => {
    const emit = vi.fn(async () => {});
    const pool = fakePool({
      markets: [
        { id: "1", end_time: NOW_SECONDS - 7 * 3_600, cancelled: false },
        { id: "2", end_time: NOW_SECONDS - 60, cancelled: false },
        { id: "3", end_time: NOW_SECONDS - 99 * 3_600, cancelled: true },
      ],
    });

    const result = await runMonitorCycle(deps(pool, emit), baseConfig, NOW);

    expect(result.stuckMarkets).toBe(1);
    expect(emit).toHaveBeenCalledWith({
      type: "oracle.monitor.market_stuck",
      payload: expect.objectContaining({ marketId: "1", stuck: true }),
    });
  });

  it("flags a submission bonded below the configured minimum", async () => {
    const emit = vi.fn(async () => {});
    const pool = fakePool({
      bonds: [
        { market_id: "5", submitter: "GA", bond_amount: "999999999", status: "submitted" },
        { market_id: "6", submitter: "GB", bond_amount: "1000000000", status: "submitted" },
      ],
    });

    const result = await runMonitorCycle(deps(pool, emit), baseConfig, NOW);

    expect(result.lowBonds).toBe(1);
    expect(emit).toHaveBeenCalledWith({
      type: "oracle.monitor.bond_below_minimum",
      payload: expect.objectContaining({ marketId: "5", currentBond: 999_999_999n }),
    });
  });

  it("alerts once per new submission and never re-alerts the same row", async () => {
    const emit = vi.fn(async () => {});
    const pool = fakePool({
      submissions: [
        {
          id: 1,
          market_id: "4",
          submitter: "GA",
          outcome: "yes",
          bond_amount: "1000000000",
          submitted_at: "2026-01-10T11:00:00.000Z",
        },
      ],
    });
    const dependencies = deps(pool, emit);

    expect((await runMonitorCycle(dependencies, baseConfig, NOW)).newSubmissions).toBe(1);
    expect((await runMonitorCycle(dependencies, baseConfig, NOW)).newSubmissions).toBe(0);
  });

  it("alerts on council inactivity and on an exceeded council window", async () => {
    const emit = vi.fn(async () => {});
    const escalatedAt = new Date(NOW.getTime() - 80 * HOUR).toISOString();
    const pool = fakePool({
      escalated: [{ market_id: "8", escalated_at: escalatedAt, status: "escalated", vote_count: "0" }],
    });

    const result = await runMonitorCycle(deps(pool, emit), baseConfig, NOW);

    expect(result.councilInactive).toBe(1);
    expect(result.councilWindowExceeded).toBe(1);
  });
});

describe("runMonitor", () => {
  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const emit = vi.fn(async () => {});
    let cycles = 0;

    await runMonitor(deps(fakePool(), emit), baseConfig, {
      signal: controller.signal,
      intervalMs: 1,
      sleep: async () => {
        cycles += 1;
        if (cycles >= 3) controller.abort();
      },
    });

    expect(cycles).toBe(3);
  });

  it("keeps polling after a failing cycle instead of crashing", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    let queries = 0;
    const pool: QueryablePool = {
      async query<T extends Row = Row>(): Promise<{ rows: T[] }> {
        queries += 1;
        if (queries === 1) throw new Error("connection terminated unexpectedly");
        return { rows: [] as T[] };
      },
    };

    await runMonitor(deps(pool, vi.fn(async () => {})), baseConfig, {
      signal: controller.signal,
      intervalMs: 1,
      logger,
      sleep: async () => {
        if (queries > 1) controller.abort();
      },
    });

    expect(lines.some((line) => line.includes("monitor cycle failed"))).toBe(true);
    expect(lines.some((line) => line.includes("monitor cycle complete"))).toBe(true);
  });
});
