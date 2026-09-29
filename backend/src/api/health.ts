import type { FastifyPluginAsync } from "fastify";
import { pingDb, withHealthTimeout } from "../db/health.js";
import { pingRedis } from "../db/redis.js";
import { getResolutionDelayStatus } from "../db/markets.js";

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** Public shape of a dependency check — a boolean summary, no error detail. */
interface PublicCheckResult {
  ok: boolean;
  latencyMs?: number;
}

/**
 * Set once graceful shutdown begins so readiness fails immediately, before
 * the HTTP server has finished draining. That's what makes a rolling deploy
 * seamless: the load balancer stops sending new traffic as soon as shutdown
 * starts rather than waiting for requests to start failing.
 */
let shuttingDown = false;

/** Marks the process as shutting down; readiness reports "not ready" from here on. */
export function markShuttingDown(): void {
  shuttingDown = true;
}

/** Test-only: resets the shutdown flag between test runs. */
export function resetShuttingDownForTests(): void {
  shuttingDown = false;
}

function toPublicResult(result: CheckResult): PublicCheckResult {
  return result.latencyMs === undefined ? { ok: result.ok } : { ok: result.ok, latencyMs: result.latencyMs };
}

interface ReadyzResponse {
  status: "ready" | "not ready";
  checks: {
    db: PublicCheckResult;
    redis: PublicCheckResult;
  };
}

export const healthRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/readyz",
    {
      schema: {
        summary: "Readiness probe — verifies DB and Redis connectivity",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ready"] },
              checks: {
                type: "object",
                properties: {
                  db: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      latencyMs: { type: "number" },
                    },
                    required: ["ok"],
                  },
                  redis: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      latencyMs: { type: "number" },
                    },
                    required: ["ok"],
                  },
                },
                required: ["db", "redis"],
              },
            },
            required: ["status", "checks"],
          },
          503: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["not ready"] },
              checks: {
                type: "object",
                properties: {
                  db: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      latencyMs: { type: "number" },
                    },
                    required: ["ok"],
                  },
                  redis: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      latencyMs: { type: "number" },
                    },
                    required: ["ok"],
                  },
                },
                required: ["db", "redis"],
              },
            },
            required: ["status", "checks"],
          },
        },
      },
    },
    async (req, reply) => {
      // Fails immediately once shutdown starts, without waiting on the
      // dependency checks below — that's what stops a load balancer sending
      // new traffic to an instance that's already draining.
      if (shuttingDown) {
        req.log.warn("readiness check failed: shutting down");
        reply.status(503).send({ status: "not ready", checks: { db: { ok: false }, redis: { ok: false } } });
        return;
      }

      const [db, redis] = await Promise.all([
        withHealthTimeout(pingDb()),
        withHealthTimeout(pingRedis()),
      ]);

      const ready = db.ok && redis.ok;
      if (!ready) {
        // Detailed diagnostics (hostnames, driver error text, etc.) stay on
        // the logging path only — the response body never carries them.
        req.log.warn({ db, redis }, "readiness check failed");
      }

      const body: ReadyzResponse = {
        status: ready ? "ready" : "not ready",
        checks: { db: toPublicResult(db), redis: toPublicResult(redis) },
      };

      reply.status(ready ? 200 : 503).send(body);
    }
  );

  // ── GET /resolution-status ──────────────────────────────────────────────────
  // Issue #645: surface oracle-aggregator degradation. A stalled aggregator does
  // not make the API unhealthy, so this always returns 200 — the signal is in
  // the body. Alert on `status == "stalled"` or a climbing `oldestOverdueSeconds`
  // (see docs/DEPLOYMENT-GUIDE.md § "Oracle aggregator outage").
  server.get(
    "/resolution-status",
    {
      schema: {
        summary:
          "Oracle resolution health — detects aggregator unavailability from overdue markets",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["on_time", "delayed", "stalled"] },
              overdueMarkets: { type: "number" },
              oldestOverdueSeconds: { type: ["number", "null"] },
              delayedMarketIds: { type: "array", items: { type: "number" } },
              graceSeconds: { type: "number" },
              checkedAt: { type: "string" },
            },
            required: ["status", "overdueMarkets", "oldestOverdueSeconds", "checkedAt"],
          },
          503: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["unknown"] },
              error: { type: "string" },
            },
            required: ["status", "error"],
          },
        },
      },
    },
    async (_req, reply) => {
      try {
        const status = await getResolutionDelayStatus();
        reply.status(200).send(status);
      } catch (error) {
        reply.status(503).send({
          status: "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );
};
