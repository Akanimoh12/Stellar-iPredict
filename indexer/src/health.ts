/**
 * Health and readiness checks for the indexer.
 *
 * Liveness: Is the poll loop making progress?
 * Readiness: Are database and RPC dependencies reachable, and is lag acceptable?
 */

import type { Logger } from "./log.js";

export interface HealthCheckDeps {
  db: {
    query(text: string, params?: readonly unknown[]): Promise<{ rows: any[] }>;
  };
  rpc: {
    getLatestLedger(): Promise<{ sequence: number }>;
  };
  getLastProcessedLedger: () => number;
  logger?: Logger;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "unhealthy";
  timestamp: string;
  checks: {
    pollLoop?: { status: "ok" | "stalled"; lastLedger: number; stalledForMs?: number };
    database?: { status: "ok" | "unreachable"; error?: string };
    rpc?: { status: "ok" | "unreachable"; error?: string };
    lag?: { status: "ok" | "high"; ledgersBehind: number; threshold: number };
  };
}


function getMaxLagLedgers(): number {
  return Number(process.env.MAX_LAG_LEDGERS ?? 1000);
}

function getPollLoopStallThresholdMs(): number {
  return Number(process.env.POLL_LOOP_STALL_THRESHOLD_MS ?? 60_000);
}

let lastPollLoopUpdate = Date.now();
let lastProcessedLedger = 0;

/**
 * Called by the poll loop after each successful iteration to update liveness tracking.
 */
export function recordPollLoopProgress(ledger: number): void {
  lastPollLoopUpdate = Date.now();
  lastProcessedLedger = ledger;
}

/**
 * Liveness check: has the poll loop advanced recently?
 */
export function checkLiveness(): Pick<HealthStatus, "status" | "timestamp" | "checks"> {
  const now = Date.now();
  const stalledForMs = now - lastPollLoopUpdate;
  const isStalled = stalledForMs > getPollLoopStallThresholdMs();

  return {
    status: isStalled ? "unhealthy" : "ok",
    timestamp: new Date().toISOString(),
    checks: {
      pollLoop: {
        status: isStalled ? "stalled" : "ok",
        lastLedger: lastProcessedLedger,
        ...(isStalled && { stalledForMs }),
      },
    },
  };
}

/**
 * Readiness check: are dependencies reachable and is lag acceptable?
 */
export async function checkReadiness(deps: HealthCheckDeps): Promise<HealthStatus> {
  const checks: HealthStatus["checks"] = {};
  let overallStatus: HealthStatus["status"] = "ok";

  // Database check
  try {
    await deps.db.query("SELECT 1");
    checks.database = { status: "ok" };
  } catch (error) {
    checks.database = {
      status: "unreachable",
      error: error instanceof Error ? error.message : String(error),
    };
    overallStatus = "unhealthy";
    deps.logger?.error("database health check failed", { error });
  }

  // RPC check
  let latestLedger = 0;
  try {
    const latest = await deps.rpc.getLatestLedger();
    latestLedger = latest.sequence;
    checks.rpc = { status: "ok" };
  } catch (error) {
    checks.rpc = {
      status: "unreachable",
      error: error instanceof Error ? error.message : String(error),
    };
    overallStatus = "unhealthy";
    deps.logger?.error("rpc health check failed", { error });
  }

  // Lag check (only if RPC is reachable)
  if (latestLedger > 0) {
    const currentLedger = deps.getLastProcessedLedger();
    const lag = latestLedger - currentLedger;
    const maxLag = getMaxLagLedgers();

    if (lag > maxLag) {
      checks.lag = {
        status: "high",
        ledgersBehind: lag,
        threshold: maxLag,
      };
      overallStatus = overallStatus === "unhealthy" ? "unhealthy" : "degraded";
    } else {
      checks.lag = {
        status: "ok",
        ledgersBehind: lag,
        threshold: maxLag,
      };
    }
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
  };
}
