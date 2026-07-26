import type { FastifyPluginAsync } from "fastify";
import { pingDb } from "../db/health.js";
import { pingRedis } from "../db/redis.js";

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
};
