/**
 * HTTP metrics endpoint for the oracle — issue #211.
 *
 * Closes the gap called out in `infra/prometheus/prometheus.yml`: the
 * `ipredict-oracle` scrape job has been pre-provisioned against port 9101 and
 * showing DOWN because the oracle had no HTTP server. It now serves
 * `GET /metrics` in Prometheus text exposition format, matching how the
 * indexer does it (`indexer/src/metrics-server.ts`) — plain `node:http`, no
 * framework, so the oracle image gains no dependency.
 *
 * Scrapes are served from a cached snapshot that a background timer refreshes
 * (`OracleMetricsCollector`). A scrape therefore never runs a query, never
 * blocks on Postgres, and never lets a scrape storm turn into database load.
 */

import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import type { QueryablePool } from "../aggregator/tally.js";
import type { Logger } from "../log.js";
import { OracleMetricsCollector, type OracleMetricsSnapshot } from "./collector.js";
import type { OracleMetricsConfig } from "./config.js";
import { serializeOracleMetrics } from "./serialize.js";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface OracleMetricsServerOptions {
  port: number;
  host: string;
  /** Called once per scrape. Must not throw. */
  body: () => string;
  /** Reported at `GET /health`. */
  healthy?: () => boolean;
}

/**
 * Serves `GET /metrics` and `GET /health`. Everything else is a 404.
 *
 * `/health` is included for the same reason the indexer's server has one: it
 * gives `docker-compose` a `healthcheck` target for a service that otherwise
 * exposes no port at all.
 */
export class OracleMetricsServer {
  private server: Server | null = null;

  constructor(private readonly options: OracleMetricsServerOptions) {}

  /** Bound address once started, or null. Tests use it to find the port. */
  address(): { address: string; port: number } | null {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === "string") return null;
    return { address: address.address, port: address.port };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        // Strip the query string: Prometheus itself sends a bare path, but
        // `curl 'localhost:9101/metrics?debug=1'` should not 404.
        const path = (request.url ?? "").split("?")[0];

        if (request.method === "GET" && path === "/metrics") {
          const body = this.options.body();
          response.writeHead(200, {
            "Content-Type": PROMETHEUS_CONTENT_TYPE,
            "Content-Length": Buffer.byteLength(body),
          });
          response.end(body);
          return;
        }

        if (request.method === "GET" && path === "/health") {
          const healthy = this.options.healthy?.() ?? true;
          const body = JSON.stringify({ status: healthy ? "ok" : "degraded" });
          response.writeHead(healthy ? 200 : 503, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          });
          response.end(body);
          return;
        }

        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not Found\n");
      });

      // A port clash must fail the promise, not raise an unhandled 'error'
      // event after `listen` has already resolved.
      const onStartupError = (error: Error) => reject(error);
      server.once("error", onStartupError);

      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onStartupError);
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Keep-alive sockets (Prometheus reuses connections) would otherwise
      // hold `close` open until the scrape interval elapses.
      server.closeAllConnections?.();
    });
  }
}

export interface OracleMetricsRuntime {
  readonly collector: OracleMetricsCollector;
  readonly server: OracleMetricsServer | null;
  snapshot(): OracleMetricsSnapshot;
  stop(): Promise<void>;
}

export interface StartOracleMetricsOptions {
  config: OracleMetricsConfig;
  /** Pool the collector queries. When omitted, one is opened from `databaseUrl`. */
  pool?: QueryablePool;
  /** Used only when `pool` is omitted. */
  databaseUrl?: string;
  logger?: Logger;
}

/**
 * Start the collector, its refresh timer, and the HTTP server.
 *
 * When no `pool` is supplied a dedicated one is opened with `max: 2`. That is
 * deliberate: metrics queries are read-only and must never sit behind the
 * aggregator's connections waiting to run, nor starve finalization of one when
 * a scrape is slow.
 *
 * The first refresh is awaited so the very first scrape returns real numbers
 * rather than zeros. A failure there is logged and does **not** prevent the
 * endpoint from coming up — an oracle that refuses to start because its
 * metrics are unavailable trades a monitoring outage for a real one.
 */
export async function startOracleMetrics(
  options: StartOracleMetricsOptions,
): Promise<OracleMetricsRuntime> {
  const { config, logger } = options;

  const ownedPool = options.pool ? null : new Pool({ connectionString: options.databaseUrl, max: 2 });
  const pool = options.pool ?? (ownedPool as unknown as QueryablePool);

  const collector = new OracleMetricsCollector({
    pool,
    lagSeries: config.ORACLE_METRICS_LAG_SERIES,
    onError: (error, failures) => {
      logger?.error("oracle metrics refresh failed", { error, failures });
    },
  });

  let lastRefreshOk = await collector.refresh();

  if (!config.ORACLE_METRICS_ENABLED) {
    logger?.info("oracle metrics endpoint disabled", { reason: "ORACLE_METRICS_ENABLED=false" });
    return {
      collector,
      server: null,
      snapshot: () => collector.current(),
      stop: async () => {
        await ownedPool?.end();
      },
    };
  }

  const server = new OracleMetricsServer({
    port: config.ORACLE_METRICS_PORT,
    host: config.ORACLE_METRICS_HOST,
    body: () => serializeOracleMetrics(collector.current(), lastRefreshOk),
    healthy: () => lastRefreshOk,
  });

  await server.start();
  logger?.info("oracle metrics endpoint listening", {
    host: config.ORACLE_METRICS_HOST,
    port: config.ORACLE_METRICS_PORT,
    refreshMs: config.ORACLE_METRICS_REFRESH_MS,
  });

  const timer = setInterval(() => {
    void collector.refresh().then((ok) => {
      lastRefreshOk = ok;
    });
  }, config.ORACLE_METRICS_REFRESH_MS);
  // The aggregator's poll loop owns the process lifetime; the refresh timer
  // must not be what keeps it alive after a shutdown signal.
  timer.unref?.();

  return {
    collector,
    server,
    snapshot: () => collector.current(),
    stop: async () => {
      clearInterval(timer);
      await server.stop();
      await ownedPool?.end();
      logger?.info("oracle metrics endpoint stopped");
    },
  };
}
