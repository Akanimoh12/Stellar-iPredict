import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { badRequest, unauthorized, conflict } from "../lib/errors.js";
import {
  recordOracleSubmission,
  getOracleSubmissionsCount,
  hasNonceBeenUsed,
  cleanupExpiredNonces,
  type Queryable,
} from "../db/oracle.js";
import { config } from "../config/index.js";

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
  bondAmount: z.union([z.string().min(1), z.number().positive()]),
  nonce: z.string().min(1).optional(),
  timestamp: z.number().int().positive().optional(),
});

/**
 * Oracle routes as a Fastify plugin for proper versioning.
 * Mounted under /api/v1 by the main API router.
 */
export const oracleRoutes: FastifyPluginAsync = async (routes) => {
  const pool = routes.hasDecorator("pool") ? (routes as any).pool : undefined;

  routes.post(
    "/oracle/submit",
    {
      schema: {
        summary: "Provider submission intake",
        description:
          "Submit an oracle outcome for a market guarded by API-key auth with replay protection",
        tags: ["oracle"],
        security: [{ oracleApiKey: [] }],
        body: {
          type: "object",
          required: ["marketId", "outcome", "signature", "provider", "bondAmount"],
          properties: {
            marketId: { type: "number" },
            outcome: { type: "string" },
            signature: { type: "string" },
            provider: { type: "string" },
            bondAmount: { type: ["string", "number"] },
            nonce: { type: "string" },
            timestamp: { type: "number" },
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
          409: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  marketId: { type: "number" },
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
      const expectedApiKey = process.env.ORACLE_API_KEY || DEFAULT_DEV_API_KEY;

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

      const { marketId, outcome, provider, bondAmount, nonce, timestamp } = parsed.data;

      // Validate bond amount against configured minimum
      const bondNumeric = Number(bondAmount);
      const minBondStroops = config.SUBMITTER_BOND_XLM * 10_000_000; // Convert XLM to stroops
      if (bondNumeric < minBondStroops) {
        throw badRequest(
          `Bond amount ${bondNumeric} stroops is below minimum ${minBondStroops} stroops (${config.SUBMITTER_BOND_XLM} XLM)`
        );
      }

      // Replay protection: validate timestamp window
      if (timestamp !== undefined) {
        const now = Date.now();
        const timestampMs = timestamp * 1000; // Convert seconds to milliseconds
        const windowMs = config.ORACLE_TIMESTAMP_WINDOW_SEC * 1000;

        if (Math.abs(now - timestampMs) > windowMs) {
          throw badRequest(
            `Timestamp outside acceptance window of ${config.ORACLE_TIMESTAMP_WINDOW_SEC}s`,
          );
        }
      }

      // Replay protection: check nonce uniqueness
      if (nonce !== undefined) {
        const db = pool;
        const nonceUsed = await hasNonceBeenUsed(nonce, db);
        if (nonceUsed) {
          throw badRequest(`Nonce "${nonce}" has already been used`);
        }
      }

      const db = pool;

      try {
        await recordOracleSubmission(
          {
            marketId,
            provider,
            outcome: String(outcome),
            bondAmount,
            nonce,
            requestTimestamp: timestamp
              ? new Date(timestamp * 1000)
              : undefined,
          },
          db,
        );
      } catch (error: any) {
        // Handle duplicate market submission (SQLSTATE 23505)
        if (
          error.code === "23505" &&
          error.constraint === "uq_oracle_submissions_market_id"
        ) {
          throw conflict(
            `Oracle submission for market ${marketId} already exists. Each market can only have one submission.`,
          );
        }
        // Re-throw other errors
        throw error;
      }

      const count = await getOracleSubmissionsCount(marketId, db);
      const threshold = Number(
        process.env.ORACLE_THRESHOLD || DEFAULT_ORACLE_THRESHOLD,
      );
      const submissionsNeeded = Math.max(0, threshold - count);

      // Periodic nonce cleanup (every 10th request)
      if (nonce !== undefined && Math.random() < 0.1) {
        cleanupExpiredNonces(config.ORACLE_NONCE_RETENTION_SEC, db).catch(
          (err) =>
            request.log.error({ err }, "Failed to cleanup expired nonces"),
        );
      }

      return reply.status(200).send({
        accepted: true,
        submissionsNeeded,
      });
    },
  );
};

/**
 * Legacy registration function for backward compatibility.
 * @deprecated Use oracleRoutes plugin registered through API router instead.
 */
export function registerOracleRoutes(
  server: FastifyInstance,
  pool?: Pool,
  dbOverride?: Queryable,
): void {
  server.post(
    "/api/oracle/submit",
    {
      schema: {
        deprecated: true,
        summary: "[DEPRECATED] Use /api/v1/oracle/submit instead",
        description: "Legacy endpoint. Migrating to versioned API.",
        tags: ["oracle"],
        security: [{ oracleApiKey: [] }],
        body: {
          type: "object",
          required: ["marketId", "outcome", "signature", "provider", "bondAmount"],
          properties: {
            marketId: { type: "number" },
            outcome: { type: "string" },
            signature: { type: "string" },
            provider: { type: "string" },
            bondAmount: { type: ["string", "number"] },
            nonce: { type: "string" },
            timestamp: { type: "number" },
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
        },
      },
    },
    async (request, reply) => {
      request.log.warn(
        "DEPRECATED: /api/oracle/submit called. Use /api/v1/oracle/submit instead.",
      );

      const authHeader =
        request.headers.authorization ||
        (request.headers["x-api-key"] as string | undefined);
      const expectedApiKey = process.env.ORACLE_API_KEY || DEFAULT_DEV_API_KEY;

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

      const { marketId, outcome, provider, bondAmount, nonce, timestamp } = parsed.data;

      // Validate bond amount against configured minimum
      const bondNumeric = Number(bondAmount);
      const minBondStroops = config.SUBMITTER_BOND_XLM * 10_000_000; // Convert XLM to stroops
      if (bondNumeric < minBondStroops) {
        throw badRequest(
          `Bond amount ${bondNumeric} stroops is below minimum ${minBondStroops} stroops (${config.SUBMITTER_BOND_XLM} XLM)`
        );
      }

      // Replay protection: validate timestamp window
      const { marketId, outcome, provider, nonce, timestamp } = parsed.data;

      // Replay protection: validate timestamp window
      if (timestamp !== undefined) {
        const now = Date.now();
        const timestampMs = timestamp * 1000;
        const windowMs = config.ORACLE_TIMESTAMP_WINDOW_SEC * 1000;

        if (Math.abs(now - timestampMs) > windowMs) {
          throw badRequest(
            `Timestamp outside acceptance window of ${config.ORACLE_TIMESTAMP_WINDOW_SEC}s`,
          );
        }
      }

      // Replay protection: check nonce uniqueness
      if (nonce !== undefined) {
        const db = dbOverride || pool;
        const nonceUsed = await hasNonceBeenUsed(nonce, db);
        if (nonceUsed) {
          throw badRequest(`Nonce "${nonce}" has already been used`);
        }
      }

      const db = dbOverride || pool;

      try {
        await recordOracleSubmission(
          {
            marketId,
            provider,
            outcome: String(outcome),
            bondAmount,
            nonce,
            outcome: String(outcome),
            nonce,
            requestTimestamp: timestamp
              ? new Date(timestamp * 1000)
              : undefined,
          },
          db,
        );
      } catch (error: any) {
        if (
          error.code === "23505" &&
          error.constraint === "uq_oracle_submissions_market_id"
        ) {
          throw conflict(
            `Oracle submission for market ${marketId} already exists. Each market can only have one submission.`,
          );
        }
        throw error;
      }

      const count = await getOracleSubmissionsCount(marketId, db);
      const threshold = Number(
        process.env.ORACLE_THRESHOLD || DEFAULT_ORACLE_THRESHOLD,
      );
      const submissionsNeeded = Math.max(0, threshold - count);

      if (nonce !== undefined && Math.random() < 0.1) {
        cleanupExpiredNonces(config.ORACLE_NONCE_RETENTION_SEC, db).catch(
          (err) =>
            request.log.error({ err }, "Failed to cleanup expired nonces"),
        );
      }

      return reply.status(200).send({
        accepted: true,
        submissionsNeeded,
      });
    },
  );
}
