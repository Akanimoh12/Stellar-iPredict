import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { getOrSet } from "../cache/cacheAside.js";
import { statsKey } from "../cache/cacheKeys.js";
import { getGlobalStats, type Queryable } from "../db/stats.js";
import { computeEtag, matchesIfNoneMatch } from "../lib/etag.js";

const STATS_CACHE_TTL = 60;

export interface StatsResponse {
  totalMarkets: number;
  totalVolume: string;
  totalUsers: number;
  totalBets: number;
}

const statsResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    totalMarkets: { type: "number" },
    totalVolume: { type: "string" },
    totalUsers: { type: "number" },
    totalBets: { type: "number" },
  },
  required: ["totalMarkets", "totalVolume", "totalUsers", "totalBets"],
} as const;

export function registerStatsRoutes(
  server: FastifyInstance,
  pool: Pool | Queryable,
  redis?: Redis
): void {
  server.get(
    "/api/stats",
    {
      schema: {
        summary: "Platform-wide aggregate stats",
        tags: ["stats"],
        response: {
          200: statsResponseSchema,
          304: { type: "null", description: "Not modified — ETag matched" },
        },
      },
    },
    async (request, reply) => {
      const key = statsKey();

      const loader = async (): Promise<StatsResponse> => {
        const stats = await getGlobalStats(pool);
        return {
          totalMarkets: stats.totalMarkets,
          totalVolume: stats.totalVolume,
          totalUsers: stats.totalUsers,
          totalBets: stats.totalBets,
        };
      };

      const stats = redis
        ? await getOrSet(redis, key, STATS_CACHE_TTL, loader)
        : await loader();

      const etag = computeEtag(stats);
      reply.header("ETag", etag);

      if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
        return reply.status(304).send();
      }

      return reply.status(200).send(stats);
    }
  );
}
