import type { FastifyPluginAsync } from "fastify";
import { pingDb } from "../db/health.js";
import { pingRedis } from "../db/redis.js";
import type { MaintenanceMode } from "../lib/maintenance.js";

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface MaintenanceInfo {
  mode: MaintenanceMode;
}

interface ReadyzResponse {
  status: "ready" | "ready (maintenance)" | "not ready";
  checks: {
    db: CheckResult;
    redis: CheckResult;
  };
  maintenance?: MaintenanceInfo;
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
              status: { type: "string", enum: ["ready", "ready (maintenance)"] },
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
              maintenance: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["off", "read_only", "full"] },
                },
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

      // Read maintenance mode from the server-level decoration when available.
      // Falls back gracefully: if the decoration is absent or Redis is down,
      // the probe stays functional (never blocks on maintenance state errors).
      let maintenanceMode: MaintenanceMode | undefined;
      const maintenanceState = server.maintenanceState;
      if (maintenanceState) {
        try {
          maintenanceMode = await maintenanceState.getMode();
        } catch {
          // Maintenance state read failed — treat as unknown, don't block.
          maintenanceMode = undefined;
        }
      }

      const inMaintenance = maintenanceMode !== undefined && maintenanceMode !== "off";

      const body: ReadyzResponse = {
        status: !ready ? "not ready" : inMaintenance ? "ready (maintenance)" : "ready",
        checks: { db, redis },
      };

      if (inMaintenance && maintenanceMode) {
        body.maintenance = { mode: maintenanceMode };
      }

      reply.status(ready ? 200 : 503).send(body);
    }
  );
};
