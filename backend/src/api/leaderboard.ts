import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getLeaderboard, getLeaderboardTotal } from "../db/leaderboard.js";
import { getOrSet } from "../cache/cacheAside.js";
import { cacheKey } from "../cache/cacheKeys.js";
import { computeEtag, matchesIfNoneMatch } from "../lib/etag.js";

const leaderboardQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["points", "bets"]).default("points"),
});

// TTL in seconds — leaderboard changes slowly, 1 min is sufficient
const LEADERBOARD_CACHE_TTL = 60;

function leaderboardQueryKey(
  offset: number,
  limit: number,
  sort: string
): string {
  return cacheKey("leaderboard", `${sort}:${limit}:${offset}`);
}

const leaderboardResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    players: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          address: { type: "string" },
          display_name: { type: ["string", "null"] },
          points: { type: "string" },
          won_bets: { type: "number" },
          lost_bets: { type: "number" },
          updated_at: { type: "string" },
        },
        required: [
          "address",
          "display_name",
          "points",
          "won_bets",
          "lost_bets",
          "updated_at",
        ],
      },
    },
    total: { type: "number" },
  },
  required: ["players", "total"],
} as const;

const leaderboardErrorResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    issues: { type: "array" },
    requestId: { type: "string" },
  },
  required: ["code", "message", "requestId"],
} as const;

export function registerLeaderboardRoutes(
  server: FastifyInstance,
  pool: Pool,
  redis?: Redis
): void {
  server.get(
    "/api/leaderboard",
    {
      schema: {
        summary: "List leaderboard entries, paginated and sortable",
        tags: ["leaderboard"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            offset: { type: "integer", minimum: 0, description: "Row offset" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Page size",
            },
            sort: {
              type: "string",
              enum: ["points", "bets"],
              description: "Sort order",
            },
          },
        },
        response: {
          200: leaderboardResponseSchema,
          304: { type: "null", description: "Not modified — ETag matched" },
          400: leaderboardErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = leaderboardQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        return reply.status(400).send({
          code: "BAD_REQUEST",
          message: "Invalid leaderboard query parameters",
          issues: parsed.error.issues,
          requestId: request.id,
        });
      }

      const { offset, limit, sort } = parsed.data;
      const key = leaderboardQueryKey(offset, limit, sort);

      const loader = () =>
        Promise.all([
          getLeaderboard(pool, parsed.data),
          getLeaderboardTotal(pool),
        ]);

      const [players, total] = redis
        ? await getOrSet(redis, key, LEADERBOARD_CACHE_TTL, loader)
        : await loader();

      const body = { players, total };
      const etag = computeEtag(body);
      reply.header("ETag", etag);

      if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
        return reply.status(304).send();
      }

      return reply.status(200).send(body);
    }
  );
}
