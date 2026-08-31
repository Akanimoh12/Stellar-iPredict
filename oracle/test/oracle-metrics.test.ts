/**
 * Oracle Prometheus metrics endpoint — issue #211.
 *
 * The collector is tested against a fake `QueryablePool` that matches on the
 * SQL it receives, so the suite needs no database. The server is tested for
 * real over HTTP on an ephemeral port.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { QueryablePool } from "../src/aggregator/tally.js";
import {
  EMPTY_SNAPSHOT,
  OracleMetricsCollector,
  collectResolutionLag,
  countDisputes,
  countSubmissions,
} from "../src/metrics/collector.js";
import {
  ORACLE_METRICS_DEFAULT_PORT,
  loadOracleMetricsConfig,
} from "../src/metrics/config.js";
import { serializeOracleMetrics } from "../src/metrics/serialize.js";
import { OracleMetricsServer } from "../src/metrics/server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeTables {
  submissions?: number;
  disputes?: number;
  lag?: Array<{ market_id: string; end_time: number; finalized_at_epoch: number }>;
}

/** A `QueryablePool` that answers by matching on the table each query names. */
function fakePool(tables: FakeTables, onQuery?: (sql: string, params?: unknown[]) => void) {
  const queries: string[] = [];
  const pool: QueryablePool = {
    async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push(sql);
      onQuery?.(sql, params);

      if (sql.includes("COUNT(*)") && sql.includes("oracle_submissions")) {
        // `pg` returns bigint COUNT(*) as a string; the collector must cope.
        return { rows: [{ count: String(tables.submissions ?? 0) }] as unknown as T[] };
      }
      if (sql.includes("COUNT(*)") && sql.includes("oracle_disputes")) {
        return { rows: [{ count: String(tables.disputes ?? 0) }] as unknown as T[] };
      }
      if (sql.includes("finalized_at")) {
        const rows = (tables.lag ?? []).slice(0, Number(params?.[0] ?? Infinity));
        return { rows: rows as unknown as T[] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, queries };
}

const failingPool: QueryablePool = {
  async query() {
    throw new Error("connection terminated unexpectedly");
  },
};

/** Parse an exposition body into `name{labels} -> value`. */
function parseExposition(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.lastIndexOf(" ");
    out[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

describe("oracle metrics collector", () => {
  it("reads submission and dispute totals as numbers", async () => {
    const { pool } = fakePool({ submissions: 42, disputes: 7 });

    await expect(countSubmissions(pool)).resolves.toBe(42);
    await expect(countDisputes(pool)).resolves.toBe(7);
  });

  it("reports zero rather than NaN for an empty table", async () => {
    const emptyPool: QueryablePool = {
      async query() {
        return { rows: [] };
      },
    };
    await expect(countSubmissions(emptyPool)).resolves.toBe(0);
  });

  it("computes resolution lag in hours from expiry to finalization", async () => {
    const { pool } = fakePool({
      lag: [
        { market_id: "12", end_time: 1_000_000, finalized_at_epoch: 1_000_000 + 9_000 },
        { market_id: "11", end_time: 2_000_000, finalized_at_epoch: 2_000_000 - 1_800 },
      ],
    });

    const samples = await collectResolutionLag(pool, 100);

    expect(samples).toEqual([
      { marketId: "12", lagHours: 2.5 },
      // Finalized before expiry — negative lag is meaningful, not an error.
      { marketId: "11", lagHours: -0.5 },
    ]);
  });

  it("passes the series cap to the query and drops duplicate market ids", async () => {
    let limit: unknown;
    const { pool } = fakePool(
      {
        lag: [
          { market_id: "5", end_time: 0, finalized_at_epoch: 3_600 },
          { market_id: "5", end_time: 0, finalized_at_epoch: 7_200 },
        ],
      },
      (sql, params) => {
        if (sql.includes("finalized_at")) limit = params?.[0];
      },
    );

    const samples = await collectResolutionLag(pool, 25);

    expect(limit).toBe(25);
    // Two samples with identical labels would make Prometheus reject the
    // whole scrape, so the newest wins and the duplicate is dropped.
    expect(samples).toEqual([{ marketId: "5", lagHours: 1 }]);
  });

  it("keeps the previous snapshot when a refresh fails", async () => {
    let failing = false;
    const pool: QueryablePool = {
      async query<T extends Record<string, unknown>>(sql: string) {
        if (failing) throw new Error("db down");
        if (sql.includes("oracle_submissions") && sql.includes("COUNT")) {
          return { rows: [{ count: "10" }] as unknown as T[] };
        }
        if (sql.includes("oracle_disputes")) {
          return { rows: [{ count: "2" }] as unknown as T[] };
        }
        return { rows: [] as unknown as T[] };
      },
    };

    const collector = new OracleMetricsCollector({ pool, lagSeries: 100 });
    await expect(collector.refresh()).resolves.toBe(true);
    expect(collector.current().submissionsTotal).toBe(10);

    failing = true;
    await expect(collector.refresh()).resolves.toBe(false);

    // Blanking the counter would look to Prometheus like a counter reset and
    // spike every rate() over it. The staleness is reported separately.
    expect(collector.current().submissionsTotal).toBe(10);
    expect(collector.current().disputesTotal).toBe(2);
    expect(collector.current().collectionErrors).toBe(1);
  });

  it("reports the failure through onError without throwing", async () => {
    const seen: number[] = [];
    const collector = new OracleMetricsCollector({
      pool: failingPool,
      lagSeries: 10,
      onError: (_error, failures) => seen.push(failures),
    });

    await expect(collector.refresh()).resolves.toBe(false);
    await expect(collector.refresh()).resolves.toBe(false);

    expect(seen).toEqual([1, 2]);
    expect(collector.errorCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("serializeOracleMetrics", () => {
  it("emits the metric names the Grafana oracle dashboard queries", () => {
    const body = serializeOracleMetrics({
      submissionsTotal: 128,
      disputesTotal: 9,
      resolutionLag: [
        { marketId: "12", lagHours: 2.5 },
        { marketId: "13", lagHours: 0 },
      ],
      lastRefreshUnixSeconds: 1_700_000_000,
      collectionErrors: 0,
    });

    const samples = parseExposition(body);
    expect(samples.oracle_submissions_total).toBe("128");
    expect(samples.oracle_disputes_total).toBe("9");
    expect(samples['oracle_resolution_lag_h{market_id="12"}']).toBe("2.5");
    expect(samples['oracle_resolution_lag_h{market_id="13"}']).toBe("0");
    expect(samples.oracle_up).toBe("1");
    expect(samples.oracle_metrics_last_refresh_timestamp_seconds).toBe("1700000000");
    expect(samples.oracle_metrics_collection_errors_total).toBe("0");
  });

  it("declares a HELP and TYPE line for every metric it emits", () => {
    const body = serializeOracleMetrics(EMPTY_SNAPSHOT);

    for (const name of [
      "oracle_submissions_total",
      "oracle_disputes_total",
      "oracle_resolution_lag_h",
      "oracle_up",
      "oracle_metrics_last_refresh_timestamp_seconds",
      "oracle_metrics_collection_errors_total",
    ]) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} `);
    }
    expect(body.endsWith("\n")).toBe(true);
  });

  it("keeps the lag series discoverable before any market resolves", () => {
    const body = serializeOracleMetrics(EMPTY_SNAPSHOT);
    expect(body).toContain("# TYPE oracle_resolution_lag_h gauge");
    expect(body).not.toContain("oracle_resolution_lag_h{");
  });

  it("reports oracle_up 0 when the collector cannot reach its dependencies", () => {
    const body = serializeOracleMetrics(EMPTY_SNAPSHOT, false);
    expect(parseExposition(body).oracle_up).toBe("0");
  });

  it("escapes label values instead of producing an unparseable line", () => {
    const body = serializeOracleMetrics({
      ...EMPTY_SNAPSHOT,
      resolutionLag: [{ marketId: 'we"ird', lagHours: 1 }],
    });
    expect(body).toContain('oracle_resolution_lag_h{market_id="we\\"ird"} 1');
  });
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

describe("OracleMetricsServer", () => {
  const servers: OracleMetricsServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function listen(options: {
    body: () => string;
    healthy?: () => boolean;
  }): Promise<string> {
    const server = new OracleMetricsServer({ port: 0, host: "127.0.0.1", ...options });
    servers.push(server);
    await server.start();
    const address = server.address();
    expect(address).not.toBeNull();
    return `http://127.0.0.1:${address!.port}`;
  }

  it("serves the exposition body with the Prometheus content type", async () => {
    const base = await listen({ body: () => serializeOracleMetrics(EMPTY_SNAPSHOT) });

    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await response.text()).toContain("oracle_submissions_total 0");
  });

  it("ignores a query string on /metrics", async () => {
    const base = await listen({ body: () => serializeOracleMetrics(EMPTY_SNAPSHOT) });

    const response = await fetch(`${base}/metrics?debug=1`);

    expect(response.status).toBe(200);
  });

  it("reports 503 at /health once refreshes are failing", async () => {
    let healthy = true;
    const base = await listen({
      body: () => serializeOracleMetrics(EMPTY_SNAPSHOT, healthy),
      healthy: () => healthy,
    });

    await expect(fetch(`${base}/health`).then((r) => r.status)).resolves.toBe(200);

    healthy = false;
    const degraded = await fetch(`${base}/health`);
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toEqual({ status: "degraded" });
  });

  it("404s anything else", async () => {
    const base = await listen({ body: () => "" });

    await expect(fetch(`${base}/`).then((r) => r.status)).resolves.toBe(404);
    await expect(fetch(`${base}/metrics/../etc`).then((r) => r.status)).resolves.toBe(404);
  });

  it("rejects start() when the port is already taken", async () => {
    const first = new OracleMetricsServer({ port: 0, host: "127.0.0.1", body: () => "" });
    servers.push(first);
    await first.start();
    const port = first.address()!.port;

    const second = new OracleMetricsServer({ port, host: "127.0.0.1", body: () => "" });
    // A clash must reject start(), not surface later as an unhandled 'error'.
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
  });

  it("stop() is safe to call when never started", async () => {
    await expect(new OracleMetricsServer({ port: 0, host: "::", body: () => "" }).stop())
      .resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("loadOracleMetricsConfig", () => {
  it("defaults to the port prometheus.yml already scrapes", () => {
    const config = loadOracleMetricsConfig({});

    expect(config.ORACLE_METRICS_PORT).toBe(ORACLE_METRICS_DEFAULT_PORT);
    expect(ORACLE_METRICS_DEFAULT_PORT).toBe(9101);
    expect(config.ORACLE_METRICS_HOST).toBe("0.0.0.0");
    expect(config.ORACLE_METRICS_ENABLED).toBe(true);
    expect(config.ORACLE_METRICS_REFRESH_MS).toBe(15_000);
    expect(config.ORACLE_METRICS_LAG_SERIES).toBe(100);
  });

  it("accepts the boolean spellings that appear in .env files", () => {
    for (const value of ["false", "FALSE", "0", "no", "off"]) {
      expect(loadOracleMetricsConfig({ ORACLE_METRICS_ENABLED: value }).ORACLE_METRICS_ENABLED)
        .toBe(false);
    }
    for (const value of ["true", "1", "yes", "on"]) {
      expect(loadOracleMetricsConfig({ ORACLE_METRICS_ENABLED: value }).ORACLE_METRICS_ENABLED)
        .toBe(true);
    }
  });

  it("treats an empty value as unset, like the other oracle schemas", () => {
    expect(loadOracleMetricsConfig({ ORACLE_METRICS_ENABLED: "" }).ORACLE_METRICS_ENABLED)
      .toBe(true);
  });

  it("rejects a typo instead of silently disabling the endpoint", () => {
    expect(() => loadOracleMetricsConfig({ ORACLE_METRICS_ENABLED: "ture" })).toThrow();
    expect(() => loadOracleMetricsConfig({ ORACLE_METRICS_PORT: "0" })).toThrow();
    expect(() => loadOracleMetricsConfig({ ORACLE_METRICS_PORT: "99999" })).toThrow();
  });
});
