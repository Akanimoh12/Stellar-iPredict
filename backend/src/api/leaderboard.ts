import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getLeaderboard, getLeaderboardTotal } from "../db/leaderboard.js";
import { getOrSet } from "../cache/cacheAside.js";
import { cacheKey } from "../cache/cacheKeys.js";

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

export function registerLeaderboardRoutes(
  server: FastifyInstance,
  pool: Pool,
  redis?: Redis
): void {
  server.get("/api/leaderboard", async (request, reply) => {
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

    return reply.status(200).send({ players: players ?? [], total: total ?? 0 });
  });
}
