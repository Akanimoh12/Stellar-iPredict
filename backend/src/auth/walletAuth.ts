import crypto from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { unauthorized, forbidden, badRequest, type HttpError } from "../lib/errors.js";
import { isValidAddress, normalizeAddress } from "../lib/address.js";
import { queryWithCancel, type CancellablePool } from "../db/pool.js";

/**
 * Wallet-based authentication for a Stellar address platform.
 *
 * Uses signature-based challenge-response: the server issues a nonce, the
 * client signs it with their private key, and the server verifies the
 * signature against the claimed address. This proves control of the address
 * without ever custodying or transmitting private keys.
 *
 * The plugin provides:
 * - A reusable Fastify decorator `walletAuth` for route-level protection
 * - A `GET /auth/challenge` endpoint to obtain a nonce
 * - A `POST /auth/verify` endpoint to verify a signed challenge
 * - Automatic nonce cleanup and replay protection
 */

export const CHALLENGE_PREFIX = "ipredict-auth";
export const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
export const MAX_NONCE_STORE_SIZE = 10000;

/**
 * Shape of a stored nonce record.
 */
export interface NonceRecord {
  nonce: string;
  address: string;
  createdAt: number;
  used: boolean;
}

/**
 * In-memory nonce store. In production this should be backed by Redis
 * for multi-instance deployments, but an in-memory Map works for single
 * instance and is sufficient for the authentication flow.
 */
const nonceStore = new Map<string, NonceRecord>();

/**
 * Generate a cryptographically secure random nonce.
 */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Build the canonical message that the user signs.
 *
 * Format (LF-separated, no trailing newline):
 * ```
 * ipredict-auth
 * address:<address>
 * nonce:<nonce>
 * timestamp:<unix_timestamp_seconds>
 * ```
 */
export function buildChallengeMessage(address: string, nonce: string, timestamp: number): string {
  return [
    CHALLENGE_PREFIX,
    `address:${address}`,
    `nonce:${nonce}`,
    `timestamp:${timestamp}`,
  ].join("\n");
}

/**
 * Verify a signature over the challenge message.
 */
export function verifyChallengeSignature(
  address: string,
  nonce: string,
  timestamp: number,
  signature: string
): boolean {
  if (!signature) return false;
  const message = buildChallengeMessage(address, nonce, timestamp);
  try {
    return Keypair.fromPublicKey(address).verify(
      Buffer.from(message, "utf8"),
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

/**
 * Store a nonce for later verification.
 */
export function storeNonce(nonce: string, address: string): void {
  // Clean up expired nonces periodically
  if (nonceStore.size >= MAX_NONCE_STORE_SIZE) {
    cleanupExpiredNonces();
  }

  nonceStore.set(nonce, {
    nonce,
    address: normalizeAddress(address),
    createdAt: Date.now(),
    used: false,
  });
}

/**
 * Consume a nonce (mark as used and return the record).
 * Returns null if nonce is invalid, expired, or already used.
 */
export function consumeNonce(nonce: string, address: string): NonceRecord | null {
  const record = nonceStore.get(nonce);
  if (!record) return null;

  const now = Date.now();
  const ageSeconds = (now - record.createdAt) / 1000;

  // Check expiration
  if (ageSeconds > CHALLENGE_TTL_SECONDS) {
    nonceStore.delete(nonce);
    return null;
  }

  // Check address match
  if (record.address !== normalizeAddress(address)) {
    return null;
  }

  // Check replay
  if (record.used) {
    return null;
  }

  // Mark as used
  record.used = true;
  return record;
}

/**
 * Remove expired nonces from the store.
 */
export function cleanupExpiredNonces(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [nonce, record] of nonceStore.entries()) {
    const ageSeconds = (now - record.createdAt) / 1000;
    if (ageSeconds > CHALLENGE_TTL_SECONDS || record.used) {
      nonceStore.delete(nonce);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Fastify plugin that adds wallet authentication support.
 *
 * Registers:
 * - GET /auth/challenge - Get a nonce for signing
 * - POST /auth/verify - Verify a signed challenge
 * - Decorates `request.user` with authenticated address on protected routes
 */
export const walletAuthPlugin: FastifyPluginAsync = async (app) => {
  // Challenge endpoint - public, returns a nonce
  app.get(
    "/auth/challenge",
    {
      schema: {
        summary: "Get an authentication challenge nonce",
        description:
          "Returns a cryptographic nonce that the client must sign with their " +
          "Stellar private key to prove address ownership. The nonce expires in " +
          `${CHALLENGE_TTL_SECONDS} seconds and can only be used once.`,
        tags: ["auth"],
        querystring: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              type: "string",
              description: "Stellar public key address (G...)",
              pattern: "^G[A-Z2-7]{55}$",
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["nonce", "expiresIn", "message"],
            properties: {
              nonce: { type: "string", description: "Base64url-encoded random nonce" },
              expiresIn: { type: "number", description: "Seconds until nonce expires" },
              message: {
                type: "string",
                description: "The exact message to sign (for client-side verification)",
              },
            },
          },
          400: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message", "requestId"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  requestId: { type: "string" },
                  details: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        field: { type: "string" },
                        message: { type: "string" },
                      },
                      required: ["field", "message"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.query as { address: string };

      if (!address || !isValidAddress(address)) {
        throw badRequest("Invalid Stellar address");
      }

      const normalizedAddress = normalizeAddress(address);
      const nonce = generateNonce();
      const timestamp = Math.floor(Date.now() / 1000);
      const message = buildChallengeMessage(normalizedAddress, nonce, timestamp);

      storeNonce(nonce, normalizedAddress);

      return reply.status(200).send({
        nonce,
        expiresIn: CHALLENGE_TTL_SECONDS,
        message,
      });
    }
  );

  // Verify endpoint - public, verifies signature and returns auth token
  app.post(
    "/auth/verify",
    {
      schema: {
        summary: "Verify a signed authentication challenge",
        description:
          "Verifies a signature over the challenge message. On success, returns " +
          "an authentication token that can be used as a Bearer token for " +
          "subsequent authenticated requests.",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["address", "nonce", "signature", "timestamp"],
          properties: {
            address: { type: "string", pattern: "^G[A-Z2-7]{55}$" },
            nonce: { type: "string", minLength: 1 },
            signature: { type: "string", minLength: 1, description: "Base64-encoded signature" },
            timestamp: { type: "number", description: "Unix timestamp from challenge" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["token", "address", "expiresIn"],
            properties: {
              token: { type: "string", description: "Bearer token for authenticated requests" },
              address: { type: "string", description: "Verified Stellar address" },
              expiresIn: { type: "number", description: "Token validity in seconds" },
            },
          },
          400: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message", "requestId"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  requestId: { type: "string" },
                  details: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        field: { type: "string" },
                        message: { type: "string" },
                      },
                      required: ["field", "message"],
                    },
                  },
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
                required: ["code", "message", "requestId"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  requestId: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { address, nonce, signature, timestamp } = request.body as {
        address: string;
        nonce: string;
        signature: string;
        timestamp: number;
      };

      if (!address || !isValidAddress(address)) {
        throw badRequest("Invalid Stellar address");
      }

      const normalizedAddress = normalizeAddress(address);

      // Validate timestamp is recent (within challenge TTL)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestamp) > CHALLENGE_TTL_SECONDS) {
        throw badRequest("Challenge timestamp expired");
      }

      // Consume nonce (validates address match, expiration, and replay)
      const record = consumeNonce(nonce, normalizedAddress);
      if (!record) {
        throw unauthorized("Invalid or expired challenge");
      }

      // Verify signature
      if (!verifyChallengeSignature(normalizedAddress, nonce, timestamp, signature)) {
        throw unauthorized("Invalid signature");
      }

      // Generate auth token (simple approach: signed JWT or random token stored in DB)
      // For simplicity, we use a signed token that embeds the address and expiry
      const token = generateAuthToken(normalizedAddress);

      return reply.status(200).send({
        token,
        address: normalizedAddress,
        expiresIn: 24 * 60 * 60, // 24 hours
      });
    }
  );

  // Decorator for protecting routes
  app.decorate("requireWalletAuth", async function (
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw unauthorized("Missing or invalid Authorization header");
    }

    const token = authHeader.slice(7).trim();
    const address = verifyAuthToken(token);
    if (!address) {
      throw unauthorized("Invalid or expired authentication token");
    }

    // Attach user to request
    (request as any).user = { address };
  });
};

/**
 * Generate a simple authentication token.
 * In production, use a proper JWT library. This is a minimal implementation
 * using HMAC for integrity.
 */
function generateAuthToken(address: string): string {
  const secret = process.env.AUTH_TOKEN_SECRET ?? "dev-secret-change-in-production";
  const payload = {
    address,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
    iat: Math.floor(Date.now() / 1000),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verify an authentication token and return the address if valid.
 */
export function verifyAuthToken(token: string): string | null {
  const secret = process.env.AUTH_TOKEN_SECRET ?? "dev-secret-change-in-production";
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    if (!payload.address || !isValidAddress(payload.address)) return null;
    return normalizeAddress(payload.address);
  } catch {
    return null;
  }
}

/**
 * Type augmentation for Fastify request with authenticated user.
 */
declare module "fastify" {
  interface FastifyRequest {
    user?: {
      address: string;
    };
  }
}