import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getLeaderboard, getLeaderboardTotal } from "../db/leaderboard.js";
import { getOrSet } from "../cache/cacheAside.js";
import { cacheKey, CACHE_TTLS } from "../cache/cacheKeys.js";
import { cacheControlPublic } from "../cache/cacheControl.js";

const leaderboardQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["points", "bets"]).default("points"),
});

// TTL in seconds — sourced from CACHE_TTLS so the header and Redis TTL
// never drift apart (#480).
const LEADERBOARD_CACHE_TTL = CACHE_TTLS.leaderboardTop20;

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
        summary: "Leaderboard rankings",
        description:
          "Returns a paginated leaderboard of top players by points or bet count. " +
          "This is aggregate, non-user-specific data safe for shared caches.",
        tags: ["leaderboard"],
        querystring: {
          type: "object",
          properties: {
            offset: { type: "integer", minimum: 0, description: "Pagination offset" },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size" },
            sort: { type: "string", enum: ["points", "bets"], description: "Sort field" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            headers: {
              "Cache-Control": {
                type: "string",
                description:
                  "Cache directives. max-age mirrors the server-side Redis TTL (60s).",
                example: "public, max-age=60, stale-while-revalidate=60",
              },
            },
            properties: {
              players: { type: "array", items: { type: "object" } },
              total: { type: "number" },
            },
            required: ["players", "total"],
          },
          400: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              issues: { type: "array", items: { type: "object" } },
            },
            required: ["code", "message"],
          },
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

      reply.header("Cache-Control", cacheControlPublic(LEADERBOARD_CACHE_TTL));
      return reply.status(200).send({ players, total });
    },
  );
}
