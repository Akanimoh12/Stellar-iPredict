import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { getOrSet } from "../cache/cacheAside.js";
import { statsKey } from "../cache/cacheKeys.js";
import { getGlobalStats, type Queryable } from "../db/stats.js";

const STATS_CACHE_TTL = 60;

export interface StatsResponse {
  totalMarkets: number;
  totalVolume: string;
  totalUsers: number;
  totalBets: number;
}


export function registerStatsRoutes(
  server: FastifyInstance,
  pool: Pool | Queryable,
  redis?: Redis
): void {
  server.get("/api/stats", async (_request, reply) => {
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

    return reply.status(200).send(stats);
  });
}
