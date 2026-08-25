/**
 * Oracle monitor — the observability half of the oracle stack.
 *
 * The aggregator *acts* (tallies council votes, finalizes markets). The
 * monitor only *watches*: every cycle it re-runs the read-only checks in
 * `aggregator/` against Postgres and emits an alert for anything an operator
 * needs to look at. It never signs or submits a transaction, so it is safe to
 * run without a resolver key — which is why it is a separate service in
 * `infra/docker-compose.production.yml` rather than a thread of the
 * aggregator.
 *
 * Checks per cycle (see `docs/ORACLE_AND_BACKEND.md#oracle-monitoring-requirements`):
 *   - markets unresolved N hours past expiry
 *   - new bonded submissions
 *   - disputes escalated to council
 *   - submissions posted with a bond below the minimum
 *   - escalated markets the council has not voted on / has run the clock out on
 */

import { Pool } from "pg";
import { checkBondMinimumFromDb } from "../aggregator/bond-monitor.js";
import {
  checkCouncilInactivityFromDb,
  checkCouncilWindowExceededFromDb,
} from "../aggregator/council-inactivity-monitor.js";
import { DisputeEscalationWatcher } from "../aggregator/dispute-escalation-watcher.js";
import { detectStuckMarkets, type StuckMarketInput } from "../aggregator/stuck-market.js";
import { SubmissionWatcher } from "../aggregator/submission-watcher.js";
import type { QueryablePool } from "../aggregator/tally.js";
import { createLogger, type Logger } from "../log.js";
import { createAlertEmitter, type Alert, type AlertEmitter } from "./alerts.js";
import { loadMonitorConfig, xlmToStroops, type MonitorConfig } from "./config.js";

export { createAlertEmitter, serializeAlert, type Alert, type AlertEmitter, type AlertType } from "./alerts.js";
export { loadMonitorConfig, xlmToStroops, STROOPS_PER_XLM, type MonitorConfig } from "./config.js";

export interface MonitorCycleResult {
  stuckMarkets: number;
  newSubmissions: number;
  disputeEscalations: number;
  lowBonds: number;
  councilInactive: number;
  councilWindowExceeded: number;
}

export function totalAlerts(result: MonitorCycleResult): number {
  return (
    result.stuckMarkets +
    result.newSubmissions +
    result.disputeEscalations +
    result.lowBonds +
    result.councilInactive +
    result.councilWindowExceeded
  );
}

interface ExpiredMarketRow extends Record<string, unknown> {
  id: string;
  end_time: string | number;
  cancelled: boolean;
}

/**
 * Expired markets that are still open. Cancelled markets are read too so
 * `detectStuckMarkets` can filter them out with its own rule rather than the
 * rule being duplicated in SQL.
 */
export async function listExpiredUnresolvedMarkets(
  pool: QueryablePool,
  nowSeconds: number,
): Promise<StuckMarketInput[]> {
  const result = await pool.query<ExpiredMarketRow>(
    `SELECT id::text AS id, end_time, cancelled
       FROM markets
      WHERE end_time <= $1 AND resolved = FALSE
      ORDER BY end_time ASC`,
    [nowSeconds],
  );

  return result.rows.map((row) => ({
    id: row.id,
    endTime: Number(row.end_time),
    cancelled: row.cancelled,
  }));
}

export interface MonitorCycleDependencies {
  pool: QueryablePool;
  emit: AlertEmitter;
  submissionWatcher: SubmissionWatcher;
  disputeWatcher: DisputeEscalationWatcher;
}

export interface MonitorWatermarks {
  submissionId: number;
  escalatedAt: Date;
}

/**
 * Reads the current high-water marks so a freshly started monitor alerts on
 * *new* activity only. Starting the watchers at zero would replay every
 * historical submission and escalation into the alert channel on every
 * deploy, which is how operators learn to ignore the channel.
 */
export async function readWatermarks(pool: QueryablePool): Promise<MonitorWatermarks> {
  const [submissions, disputes] = await Promise.all([
    pool.query<{ max_id: string | number | null }>(
      `SELECT MAX(id) AS max_id FROM oracle_submissions`,
    ),
    pool.query<{ max_escalated_at: string | null }>(
      `SELECT MAX(escalated_at)::text AS max_escalated_at FROM oracle_disputes`,
    ),
  ]);

  const maxId = submissions.rows[0]?.max_id;
  const maxEscalatedAt = disputes.rows[0]?.max_escalated_at;

  return {
    submissionId: maxId === null || maxId === undefined ? 0 : Number(maxId),
    escalatedAt: maxEscalatedAt ? new Date(maxEscalatedAt) : new Date(0),
  };
}

export function createMonitorWatchers(
  pool: QueryablePool,
  watermarks: MonitorWatermarks,
): {
  submissionWatcher: SubmissionWatcher;
  disputeWatcher: DisputeEscalationWatcher;
} {
  return {
    // Both watchers keep an in-memory watermark, so they must be created once
    // and reused across cycles — rebuilding them each cycle would re-alert
    // every row again.
    submissionWatcher: new SubmissionWatcher(pool, {}, watermarks.submissionId),
    disputeWatcher: new DisputeEscalationWatcher(pool, {}, watermarks.escalatedAt),
  };
}

/**
 * Runs every check once. Returns how many alerts each check produced so the
 * caller can log a single summary line per cycle instead of one per check.
 */
export async function runMonitorCycle(
  dependencies: MonitorCycleDependencies,
  config: MonitorConfig,
  now: Date = new Date(),
): Promise<MonitorCycleResult> {
  const { pool, emit, submissionWatcher, disputeWatcher } = dependencies;
  const nowSeconds = Math.floor(now.getTime() / 1_000);

  const emitAll = async (type: Alert["type"], payloads: readonly object[]) => {
    for (const payload of payloads) {
      await emit({ type, payload });
    }
    return payloads.length;
  };

  const markets = await listExpiredUnresolvedMarkets(pool, nowSeconds);
  const stuck = detectStuckMarkets(markets, nowSeconds, config.STUCK_MARKET_HOURS);

  const [newSubmissions, escalations, lowBonds, inactive, windowExceeded] = await Promise.all([
    submissionWatcher.poll(),
    disputeWatcher.poll(),
    checkBondMinimumFromDb(pool, {
      requiredMinimumBond: xlmToStroops(config.SUBMITTER_BOND_XLM),
    }),
    checkCouncilInactivityFromDb(pool, now, {
      inactivityThresholdHours: config.COUNCIL_INACTIVITY_HOURS,
    }),
    checkCouncilWindowExceededFromDb(pool, now),
  ]);

  return {
    stuckMarkets: await emitAll("oracle.monitor.market_stuck", stuck),
    newSubmissions: await emitAll("oracle.monitor.submission_new", newSubmissions),
    disputeEscalations: await emitAll("oracle.monitor.dispute_escalated", escalations),
    lowBonds: await emitAll("oracle.monitor.bond_below_minimum", lowBonds),
    councilInactive: await emitAll("oracle.monitor.council_inactive", inactive),
    councilWindowExceeded: await emitAll("oracle.monitor.council_window_exceeded", windowExceeded),
  };
}

export interface RunMonitorOptions {
  signal: AbortSignal;
  intervalMs: number;
  logger?: Logger;
  /** Injected in tests; production waits on a timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Polls until aborted. A failing cycle is logged and retried on the next tick
 * rather than crashing the process: a transient Postgres blip must not take
 * the monitor down, because a down monitor is silent in exactly the same way
 * as a healthy one.
 */
export async function runMonitor(
  dependencies: MonitorCycleDependencies,
  config: MonitorConfig,
  options: RunMonitorOptions,
): Promise<void> {
  const { logger, signal, intervalMs } = options;
  const sleep = options.sleep ?? defaultSleep;

  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const result = await runMonitorCycle(dependencies, config);
      logger?.info("monitor cycle complete", {
        ...result,
        alerts: totalAlerts(result),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger?.error("monitor cycle failed", { error, durationMs: Date.now() - startedAt });
    }
    if (!signal.aborted) await sleep(intervalMs, signal);
  }
}

export async function startMonitor(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadMonitorConfig(env);
  const logger = createLogger({
    level: config.LOG_LEVEL,
    bindings: { service: "oracle-monitor" },
  });

  const database = new Pool({ connectionString: config.DATABASE_URL });
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await database.query("SELECT 1");
    logger.info("monitor started", {
      intervalMs: config.MONITOR_INTERVAL_MS,
      webhook: config.ALERT_WEBHOOK_URL ? "configured" : "none",
    });

    await runMonitor(
      {
        pool: database,
        emit: createAlertEmitter(config.ALERT_WEBHOOK_URL, logger),
        ...createMonitorWatchers(database, await readWatermarks(database)),
      },
      config,
      { signal: controller.signal, intervalMs: config.MONITOR_INTERVAL_MS, logger },
    );
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await database.end();
    logger.info("monitor stopped");
  }
}
