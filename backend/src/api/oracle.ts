import crypto from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import { badRequest, unauthorized, conflict, forbidden, notFound } from "../lib/errors.js";
import {
  recordOracleSubmission,
  getOracleSubmissionsCount,
  hasNonceBeenUsed,
  cleanupExpiredNonces,
  isRegisteredProvider,
  getIdempotencyRecord,
  storeIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  normalizeOutcome,
  CANONICAL_OUTCOMES,
  type Queryable,
} from "../db/oracle.js";
import { getMarketById } from "../db/markets.js";
import { config } from "../config/index.js";

const DEFAULT_DEV_API_KEY = "test-oracle-api-key";

export function compareSecretValues(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (candidate === undefined) {
    return false;
  }

  const candidateHash = crypto
    .createHash("sha256")
    .update(Buffer.from(candidate, "utf8"))
    .digest();
  const expectedHash = crypto
    .createHash("sha256")
    .update(Buffer.from(expected, "utf8"))
    .digest();

  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

/**
 * Values that make up the exact canonical message a provider signs.
 *
 * Field order, separators and stringification are part of the protocol: a
 * signer must reproduce this byte-for-byte or verification fails intermittently.
 * Bound/user data beyond these fields is never part of the message nor the
 * logs — see the canonical format note below.
 */
export interface OracleVerificationInput {
  marketId: number;
  outcome: string;
  provider: string;
  /** Unix timestamp in seconds, as carried in the request body (0 when absent). */
  timestamp?: number;
  /** Opaque nonce from the request body (empty when absent). */
  nonce?: string;
}

/**
 * Build the canonical, deterministic message a provider signs.
 *
 * Format (each line on its own, LF-separated, no trailing newline):
 *
 * ```
 * ipredict-oracle-submit
 * market_id:<marketId>
 * outcome:<outcome>
 * provider:<provider>
 * timestamp:<timestamp>
 * nonce:<nonce>
 * ```
 *
 * Missing `timestamp`/`nonce` serialise as `0` / empty string so the message
 * is still deterministic — a signer uses the exact same values it put in the
 * request body. Do not reorder fields or change stringification; that would
 * break every existing signature.
 */
export function buildCanonicalOracleMessage(
  input: OracleVerificationInput,
): string {
  const timestamp = input.timestamp ?? 0;
  const nonce = input.nonce ?? "";
  return [
    "ipredict-oracle-submit",
    `market_id:${input.marketId}`,
    `outcome:${input.outcome}`,
    `provider:${input.provider}`,
    `timestamp:${timestamp}`,
    `nonce:${nonce}`,
  ].join("\n");
}

/**
 * Verify an oracle submission signature against the claimed `provider`
 * public key using the Stellar SDK.
 *
 * The signature is expected in the base64 form produced by
 * `Keypair.sign(...)`. Any failure (invalid key, malformed signature,
 * mismatched key) returns `false` rather than throwing.
 */
export function verifyOracleSubmissionSignature(
  input: OracleVerificationInput,
  signature: string,
): boolean {
  if (!signature) {
    return false;
  }
  const message = buildCanonicalOracleMessage(input);
  try {
    return Keypair.fromPublicKey(input.provider).verify(
      Buffer.from(message, "utf8"),
      signature,
    );
  } catch {
    return false;
  }
}

/** Sign the canonical message with a provider keypair (helper for tests/docs). */
export function signOracleMessage(
  input: OracleVerificationInput,
  kp: Keypair,
): string {
  const message = buildCanonicalOracleMessage(input);
  return kp.sign(Buffer.from(message, "utf8")).toString("base64");
}

/**
 * `outcome` — markets are binary, so this is a closed set (issue #650).
 * Booleans and case-insensitive string spellings (`"yes"`, `"YES "`,
 * `"true"`, `"1"`) are normalised to the canonical `YES` / `NO`; anything
 * else is rejected here with 400. Providers sign the **canonical** value —
 * see `buildCanonicalOracleMessage`.
 */
const outcomeSchema = z
  .union([z.string(), z.boolean()])
  .transform((raw, ctx): "YES" | "NO" => {
    const normalized = normalizeOutcome(raw);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome must be one of ${CANONICAL_OUTCOMES.join(
          ", ",
        )} (accepts yes/no, true/false, y/n, 1/0 — case-insensitive)`,
      });
      return z.NEVER;
    }
    return normalized;
  });

const oracleSubmitBodySchema = z.object({
  marketId: z.number().int().positive(),
  outcome: outcomeSchema,
  signature: z.string().min(1),
  provider: z.string().min(1),
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
          required: ["marketId", "outcome", "signature", "provider"],
          properties: {
            marketId: { type: "number" },
            outcome: {
              description: "Binary market outcome. Canonical form YES/NO; yes/no, true/false, y/n, 1/0 accepted (case-insensitive) and normalised.",
              oneOf: [{ type: "string" }, { type: "boolean" }],
            },
            signature: { type: "string" },
            provider: { type: "string" },
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
          403: {
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
          404: {
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

      if (!compareSecretValues(token, expectedApiKey)) {
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

      const { marketId, outcome, provider, signature, nonce, timestamp } =
        parsed.data;

      // Signature verification: the payload must be signed by the claimed
      // provider keypair before it is trusted or written. Never record a
      // submission with an invalid or mismatched signature.
      const signed = verifyOracleSubmissionSignature(
        { marketId, outcome: String(outcome), provider, timestamp, nonce },
        signature,
      );
      if (!signed) {
        throw unauthorized(
          "Invalid oracle submission signature; ensure it was produced by the claimed provider keypair",
        );
      }

      // Issue #438: Reject unregistered oracle providers
      const db = pool;
      const isProviderRegistered = await isRegisteredProvider(provider, db);
      if (!isProviderRegistered) {
        throw forbidden(
          `Provider "${provider}" is not a registered oracle provider`,
        );
      }

      // Issue #439: Validate market preconditions before accepting submission
      const market = await getMarketById(marketId, db);
      if (!market) {
        throw notFound(`Market ${marketId} does not exist`);
      }
      if (market.resolved) {
        throw badRequest(`Market ${marketId} is already resolved`);
      }
      if (market.cancelled) {
        throw badRequest(`Market ${marketId} is cancelled`);
      }
      const now = Date.now();
      if (Number(market.end_time) * 1000 > now) {
        throw badRequest(
          `Market ${marketId} has not expired yet — submissions are only accepted after the market end time`,
        );
      }

      // Replay protection: validate timestamp window
      if (timestamp !== undefined) {
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
        const nonceUsed = await hasNonceBeenUsed(nonce, db);
        if (nonceUsed) {
          throw badRequest(`Nonce "${nonce}" has already been used`);
        }
      }

      // Issue #441: Idempotency key support
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      if (idempotencyKey) {
        const existing = await getIdempotencyRecord(idempotencyKey, db);
        if (existing) {
          const payloadHash = crypto
            .createHash("sha256")
            .update(JSON.stringify(request.body))
            .digest("hex");
          if (existing.payload_hash !== payloadHash) {
            throw conflict(
              `Idempotency key "${idempotencyKey}" was used with a different payload`,
            );
          }
          return reply
            .status(existing.status_code as 200 | 400 | 401 | 403 | 404 | 409)
            .send(existing.response_body);
        }
      }

      let responseStatus: 200 | 400 | 401 | 403 | 404 | 409 = 200;
      let responseBody: unknown;

      try {
        await recordOracleSubmission(
          {
            marketId,
            provider,
            outcome: String(outcome),
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
      const submissionsNeeded = Math.max(
        0,
        config.ORACLE_THRESHOLD - count,
      );

      responseBody = { accepted: true, submissionsNeeded };
      responseStatus = 200;

      // Store idempotency record if key was provided
      if (idempotencyKey) {
        const payloadHash = crypto
          .createHash("sha256")
          .update(JSON.stringify(request.body))
          .digest("hex");
        await storeIdempotencyRecord(
          idempotencyKey,
          payloadHash,
          responseBody,
          responseStatus,
          db,
        );
      }

      // Periodic nonce cleanup (every 10th request)
      if (nonce !== undefined && Math.random() < 0.1) {
        cleanupExpiredNonces(config.ORACLE_NONCE_RETENTION_SEC, db).catch(
          (err) =>
            request.log.error({ err }, "Failed to cleanup expired nonces"),
        );
      }

      // Periodic idempotency key cleanup (every 20th request)
      if (idempotencyKey !== undefined && Math.random() < 0.05) {
        cleanupExpiredIdempotencyKeys(
          config.ORACLE_IDEMPOTENCY_RETENTION_SEC,
          db,
        ).catch((err) =>
          request.log.error({ err }, "Failed to cleanup expired idempotency keys"),
        );
      }

      return reply.status(responseStatus).send(responseBody);
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
  // Validate that a database is available at registration time, not per-request.
  // This fails loudly at startup when the route is misconfigured.
  if (!pool && !dbOverride) {
    throw new Error(
      "Oracle routes require a database pool. Pass options.pool to buildServer or dbOverride to registerOracleRoutes.",
    );
  }

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
          required: ["marketId", "outcome", "signature", "provider"],
          properties: {
            marketId: { type: "number" },
            outcome: {
              description: "Binary market outcome. Canonical form YES/NO; yes/no, true/false, y/n, 1/0 accepted (case-insensitive) and normalised.",
              oneOf: [{ type: "string" }, { type: "boolean" }],
            },
            signature: { type: "string" },
            provider: { type: "string" },
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
          403: {
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
          404: {
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
                },
              },
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

      if (!compareSecretValues(token, expectedApiKey)) {
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

      const { marketId, outcome, provider, signature, nonce, timestamp } =
        parsed.data;

      // Signature verification: the payload must be signed by the claimed
      // provider keypair before it is trusted or written. Never record a
      // submission with an invalid or mismatched signature.
      const signed = verifyOracleSubmissionSignature(
        { marketId, outcome: String(outcome), provider, timestamp, nonce },
        signature,
      );
      if (!signed) {
        throw unauthorized(
          "Invalid oracle submission signature; ensure it was produced by the claimed provider keypair",
        );
      }

      // Issue #438: Reject unregistered oracle providers
      const db = dbOverride || pool;
      const isProviderRegistered = await isRegisteredProvider(provider, db);
      if (!isProviderRegistered) {
        throw forbidden(
          `Provider "${provider}" is not a registered oracle provider`,
        );
      }

      // Issue #439: Validate market preconditions
      const market = await getMarketById(marketId, db);
      if (!market) {
        throw notFound(`Market ${marketId} does not exist`);
      }
      if (market.resolved) {
        throw badRequest(`Market ${marketId} is already resolved`);
      }
      if (market.cancelled) {
        throw badRequest(`Market ${marketId} is cancelled`);
      }
      const now = Date.now();
      if (Number(market.end_time) * 1000 > now) {
        throw badRequest(
          `Market ${marketId} has not expired yet — submissions are only accepted after the market end time`,
        );
      }

      // Replay protection: validate timestamp window
      if (timestamp !== undefined) {
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
        const nonceUsed = await hasNonceBeenUsed(nonce, db);
        if (nonceUsed) {
          throw badRequest(`Nonce "${nonce}" has already been used`);
        }
      }

      // Issue #441: Idempotency key support
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      if (idempotencyKey) {
        const existing = await getIdempotencyRecord(idempotencyKey, db);
        if (existing) {
          const payloadHash = crypto
            .createHash("sha256")
            .update(JSON.stringify(request.body))
            .digest("hex");
          if (existing.payload_hash !== payloadHash) {
            throw conflict(
              `Idempotency key "${idempotencyKey}" was used with a different payload`,
            );
          }
          return reply
            .status(existing.status_code as 200 | 400 | 401 | 403 | 404 | 409)
            .send(existing.response_body);
        }
      }

      try {
        await recordOracleSubmission(
          {
            marketId,
            provider,
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
      const submissionsNeeded = Math.max(
        0,
        config.ORACLE_THRESHOLD - count,
      );

      const responseBody = { accepted: true, submissionsNeeded };

      if (idempotencyKey) {
        const payloadHash = crypto
          .createHash("sha256")
          .update(JSON.stringify(request.body))
          .digest("hex");
        await storeIdempotencyRecord(
          idempotencyKey,
          payloadHash,
          responseBody,
          200,
          db,
        );
      }

      if (nonce !== undefined && Math.random() < 0.1) {
        cleanupExpiredNonces(config.ORACLE_NONCE_RETENTION_SEC, db).catch(
          (err) =>
            request.log.error({ err }, "Failed to cleanup expired nonces"),
        );
      }

      return reply.status(200).send(responseBody);
    },
  );
}
