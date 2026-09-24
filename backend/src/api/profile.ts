import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { pool } from "../db/pool.js";
import { getBetsByBettor } from "../db/bets.js";
import { cacheControlNoStore } from "../cache/cacheControl.js";

// Validates a Stellar public key (starts with G, 56 characters, Base32 encoding)
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

// Paths are relative to the API prefix applied by the route index — see
// `registerApiRoutes` in ./index.ts.
export const profileRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
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
                items: { type: "object" },
              },
              points: { type: "string" },
              won_bets: { type: "number" },
              lost_bets: { type: "number" },
            },
            required: ["bets", "points", "won_bets", "lost_bets"],
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
            required: ["error", "message"],
          },
        },
      },
    },
    async (request, reply) => {
      // User-specific data: never cache, even in the browser.
      reply.header("Cache-Control", cacheControlNoStore());

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
