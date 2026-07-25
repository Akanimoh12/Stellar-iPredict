import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { getLeaderboard, getLeaderboardTotal } from "../db/leaderboard.js";

const leaderboardQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["points", "bets"]).default("points"),
});

export function registerLeaderboardRoutes(
  server: FastifyInstance,
  pool: Pool
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

    const [players, total] = await Promise.all([
      getLeaderboard(pool, parsed.data),
      getLeaderboardTotal(pool),
    ]);

    return reply.status(200).send({ players, total });
  });
}
