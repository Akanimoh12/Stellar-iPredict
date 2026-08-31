import type { FastifyPluginAsync } from "fastify";
import { pingDb } from "../db/health.js";
import { pingRedis } from "../db/redis.js";
import { getResolutionDelayStatus } from "../db/markets.js";

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface ReadyzResponse {
  status: "ready" | "not ready";
  checks: {
    db: CheckResult;
    redis: CheckResult;
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
                      error: { type: "string" },
                    },
                    required: ["ok"],
                  },
                  redis: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      latencyMs: { type: "number" },
                      error: { type: "string" },
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
    async (_req, reply) => {
      const [db, redis] = await Promise.all([pingDb(), pingRedis()]);

      const ready = db.ok && redis.ok;
      const body: ReadyzResponse = {
        status: ready ? "ready" : "not ready",
        checks: { db, redis },
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
