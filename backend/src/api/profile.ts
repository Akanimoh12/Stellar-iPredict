import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { getBetsByBettor, getBetsByBettorPaginated } from "../db/bets.js";
import { cacheControlNoStore } from "../cache/cacheControl.js";
import { MAX_PAGINATION_LIMIT, MAX_PAGINATION_OFFSET } from "../lib/pagination.js";
import { badRequest } from "../lib/errors.js";
import { INVALID_ADDRESS_MESSAGE, isValidAddress, normalizeAddress } from "../lib/address.js";

const profileBetsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGINATION_LIMIT).default(20),
});

const badRequestResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "number" },
    instance: { type: "string" },
    error: {
      type: "object",
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
      required: ["code", "message", "requestId"],
    },
  },
  required: ["type", "title", "status", "instance", "error"],
} as const;

function normalizeRequestAddress(address: string): string {
  if (!isValidAddress(address)) {
    throw badRequest(INVALID_ADDRESS_MESSAGE);
  }
  return normalizeAddress(address);
}

// Paths are relative to the API prefix applied by the route index — see
// `registerApiRoutes` in ./index.ts.
export const profileRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get<{ Params: { address: string }; Querystring: { page?: number; limit?: number } }>(
    "/profile/:address/bets",
    {
      schema: {
        summary: "Get a user's paginated bet history",
        description:
          "Returns the bets placed by a Stellar address, newest first. " +
          "This user-specific response is never cached.",
        tags: ["markets"],
        params: {
          type: "object",
          additionalProperties: false,
          properties: {
            address: { type: "string", description: "A Stellar public key." },
          },
          required: ["address"],
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: MAX_PAGINATION_LIMIT, default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            headers: {
              "Cache-Control": {
                type: "string",
                description: "Always no-store for user-specific betting history.",
                example: "no-store, no-cache, must-revalidate, private",
              },
            },
            properties: {
              bets: { type: "array", items: { type: "object", additionalProperties: true } },
              total: { type: "number" },
              page: { type: "number" },
              limit: { type: "number" },
              totalPages: { type: "number" },
            },
            required: ["bets", "total", "page", "limit", "totalPages"],
          },
          400: badRequestResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", cacheControlNoStore());

      const normalizedAddress = normalizeRequestAddress(request.params.address);

      const parsedQuery = profileBetsQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        throw badRequest("Invalid pagination parameters");
      }
      const { page, limit } = parsedQuery.data;
      const offset = (page - 1) * limit;
      if (offset > MAX_PAGINATION_OFFSET) {
        throw badRequest(
          `Requested page produces offset ${offset}, above the maximum ${MAX_PAGINATION_OFFSET}.`,
        );
      }

      try {
        const result = await getBetsByBettorPaginated(pool, normalizedAddress, page, limit);
        return reply.status(200).send(result);
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch user bet history",
        });
      }
    },
  );

  server.get<{ Params: { address: string } }>(
    "/profile/:address",
    {
      schema: {
        summary: "Get a user's profile: their bets and leaderboard stats",
        description:
          "Returns public leaderboard aggregates (points, wins, losses) and " +
          "the bet history for the given Stellar address. " +
          "**This is user-specific data — the response is marked no-store " +
          "and must never be cached by a shared proxy or CDN.**",
        tags: ["markets"],
        params: {
          type: "object",
          additionalProperties: false,
          properties: {
            address: {
              type: "string",
              description: "A Stellar public key (G…, 56 Base32 characters).",
            },
          },
          required: ["address"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            headers: {
              "Cache-Control": {
                type: "string",
                description:
                  "Always `no-store, no-cache, must-revalidate, private` — " +
                  "this endpoint returns user-specific betting history and " +
                  "must never be cached by a shared intermediary.",
                example: "no-store, no-cache, must-revalidate, private",
              },
            },
            properties: {
              bets: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              points: { type: "string" },
              won_bets: { type: "number" },
              lost_bets: { type: "number" },
            },
            required: ["bets", "points", "won_bets", "lost_bets"],
          },
          400: badRequestResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // User-specific data: never cache, even in the browser.
      reply.header("Cache-Control", cacheControlNoStore());

      const { address } = request.params;

      const normalizedAddress = normalizeRequestAddress(address);

      try {
        // Fetch user bets using existing DB method
        const bets = await getBetsByBettor(pool, normalizedAddress);

        // Fetch user leaderboard aggregates (points, wins, losses)
        const lbQuery = `
          SELECT points, won_bets, lost_bets 
          FROM leaderboard 
          WHERE address = $1;
        `;
        const lbResult = await pool.query(lbQuery, [normalizedAddress]);
        const lbStats = lbResult.rows[0];

        // Construct standard profile response, falling back to 0/empty 
        // for addresses with no existing records as per documented choice.
        const profile = {
          bets: bets || [],
          points: lbStats?.points || "0",
          won_bets: lbStats?.won_bets || 0,
          lost_bets: lbStats?.lost_bets || 0,
        };

        return reply.status(200).send(profile);
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch user profile data",
        });
      }
    }
  );
};
