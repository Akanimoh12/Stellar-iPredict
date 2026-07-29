import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { getOrSet } from "../cache/cacheAside.js";
import { statsKey } from "../cache/cacheKeys.js";

const STATS_CACHE_TTL = 60;

export interface StatsResponse {
  totalMarkets: number;
  totalVolume: string;
  totalUsers: number;
  totalBets: number;
}

export function registerStatsRoutes(
  server: FastifyInstance,
  pool: Pool,
  redis?: Redis
): void {
  server.get("/api/stats", async (_request, reply) => {
    const key = statsKey();

    const loader = async (): Promise<StatsResponse> => {
      const result = await pool.query<{
        total_markets: string;
        total_volume: string;
        total_users: string;
        total_bets: string;
      }>(`
        SELECT
          (SELECT COUNT(*)::text FROM markets) AS total_markets,
          (SELECT COALESCE(SUM(total_yes + total_no), 0)::text FROM markets) AS total_volume,
          (SELECT COUNT(DISTINCT address)::text FROM leaderboard) AS total_users,
          (SELECT COUNT(*)::text FROM bets) AS total_bets
      `);

      const row = result.rows[0];
      return {
        totalMarkets: Number(row?.total_markets ?? 0),
        totalVolume: row?.total_volume ?? "0",
        totalUsers: Number(row?.total_users ?? 0),
        totalBets: Number(row?.total_bets ?? 0),
      };
    };

    const stats = redis
      ? await getOrSet(redis, key, STATS_CACHE_TTL, loader)
      : await loader();

    return reply.status(200).send(stats);
  });
}
