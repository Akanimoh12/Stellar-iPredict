import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { badRequest, unauthorized } from "../lib/errors.js";
import {
  recordOracleSubmission,
  getOracleSubmissionsCount,
  type Queryable,
} from "../db/oracle.js";

const DEFAULT_ORACLE_THRESHOLD = 3;
const DEFAULT_DEV_API_KEY = "test-oracle-api-key";

const oracleSubmitBodySchema = z.object({
  marketId: z.number().int().positive(),
  outcome: z.union([
    z.string().min(1),
    z.boolean().transform((v) => String(v)),
  ]),
  signature: z.string().min(1),
  provider: z.string().min(1),
});

export function registerOracleRoutes(
  server: FastifyInstance,
  pool?: Pool,
  dbOverride?: Queryable
): void {
  server.post(
    "/api/oracle/submit",
    {
      schema: {
        summary: "Provider submission intake",
        description: "Submit an oracle outcome for a market guarded by API-key auth",
        tags: ["oracle"],
        security: [{ oracleApiKey: [] }],
        body: {
          type: "object",
          required: ["marketId", "outcome", "signature", "provider"],
          properties: {
            marketId: { type: "number" },
            outcome: { type: "string" },
            signature: { type: "string" },
            provider: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["accepted", "submissionsNeeded"],
            properties: {
              accepted: { type: "boolean" },
              submissionsNeeded: { type: "number" },
            },
          },
          400: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
          401: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const authHeader =
        request.headers.authorization ||
        (request.headers["x-api-key"] as string | undefined);
      const expectedApiKey =
        process.env.ORACLE_API_KEY || DEFAULT_DEV_API_KEY;

      if (!authHeader) {
        throw unauthorized("Missing authorization header");
      }

      let token = authHeader.trim();
      if (token.startsWith("Bearer ")) {
        token = token.slice(7).trim();
      } else if (token.startsWith("API-Key ")) {
        token = token.slice(8).trim();
      }

      if (token !== expectedApiKey) {
        throw unauthorized("Invalid API key");
      }

      const parsed = oracleSubmitBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid request body",
            issues: parsed.error.issues,
          },
        });
      }

      const { marketId, outcome, provider } = parsed.data;
      const db = dbOverride || pool;

      await recordOracleSubmission(
        {
          marketId,
          provider,
          outcome: String(outcome),
        },
        db
      );

      const count = await getOracleSubmissionsCount(marketId, db);
      const threshold = Number(
        process.env.ORACLE_THRESHOLD || DEFAULT_ORACLE_THRESHOLD
      );
      const submissionsNeeded = Math.max(0, threshold - count);

      return reply.status(200).send({
        accepted: true,
        submissionsNeeded,
      });
    }
  );
}
