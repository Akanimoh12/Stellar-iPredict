import { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { pool } from "../db/pool.js";
import { getBetsByBettor } from "../db/bets.js";

// Validates a Stellar public key (starts with G, 56 characters, Base32 encoding)
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const profileRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get<{ Params: { address: string } }>(
    "/api/profile/:address",
    async (request, reply) => {
      const { address } = request.params;

      if (!STELLAR_ADDRESS_REGEX.test(address)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid Stellar address format",
        });
      }

      try {
        // Fetch user bets using existing DB method
        const bets = await getBetsByBettor(pool, address);

        // Fetch user leaderboard aggregates (points, wins, losses)
        const lbQuery = `
          SELECT points, won_bets, lost_bets 
          FROM leaderboard 
          WHERE address = $1;
        `;
        const lbResult = await pool.query(lbQuery, [address]);
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
