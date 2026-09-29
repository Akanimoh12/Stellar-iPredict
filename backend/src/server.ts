import Fastify from "fastify";
import swagger from "@fastify/swagger";
import type { Queryable, GetMarketsInput } from "./db/markets";
import { getMarkets } from "./db/markets";
import { ErrorResponseSchema, HealthResponseSchema, MarketSchema, MarketListSchema, BetListSchema, LeaderboardListSchema } from "./api/openapi";

// Keep all selected columns so a new database field is visible to contract tests.
function toApi(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    value instanceof Date ? value.toISOString() : value,
  ]));
}
function market(row: Record<string, unknown>) {
  return { ...toApi(row), id: String(row.id), endTime: Number(row.end_time) };
}

export async function createApiServer(db: Queryable) {
  const app = Fastify({ logger: false });
  await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "iPredict Backend API", version: "0.1.0" } } });
  app.get("/health", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok", timestamp: new Date().toISOString(), version: "0.1.0" }));
  app.get<{ Querystring: GetMarketsInput }>("/api/v1/markets", {
    schema: {
      querystring: { type: "object", properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        category: { type: "string", enum: ["Crypto", "Sports", "Politics", "Entertainment", "Science"] },
        filter: { type: "string", enum: ["active", "resolved", "ended", "cancelled", "all"] },
        sort: { type: "string", enum: ["newest", "volume", "ending_soon", "bettors"] },
      } },
      response: { 200: MarketListSchema, 400: ErrorResponseSchema, 500: ErrorResponseSchema },
    },
  }, async request => {
    const result = await getMarkets(request.query, db);
    return { markets: result.rows.map(row => market(row)), total: result.total, page: result.page, limit: result.limit };
  });
  app.get<{ Params: { id: string } }>("/api/v1/markets/:id", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[0-9]+$" } } },
      response: { 200: MarketSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 500: ErrorResponseSchema },
    },
  }, async (request, reply) => {
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM markets WHERE id = $1", [request.params.id]);
    if (!rows[0]) return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "Market not found" });
    return market(rows[0]);
  });
  app.get<{ Querystring: { marketId?: string; bettor?: string } }>("/api/v1/bets", {
    schema: {
      querystring: { type: "object", properties: { marketId: { type: "string", pattern: "^[0-9]+$" }, bettor: { type: "string", minLength: 1 } } },
      response: { 200: BetListSchema, 400: ErrorResponseSchema, 500: ErrorResponseSchema },
    },
  }, async request => {
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT * FROM bets WHERE ($1::bigint IS NULL OR market_id = $1) AND ($2::text IS NULL OR bettor = $2) ORDER BY created_at DESC",
      [request.query.marketId ?? null, request.query.bettor ?? null],
    );
    return { bets: rows.map(row => ({ ...toApi(row), marketId: String(row.market_id) })), total: rows.length };
  });
  app.get("/api/v1/leaderboard", {
    schema: { response: { 200: LeaderboardListSchema, 500: ErrorResponseSchema } },
  }, async () => {
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM leaderboard ORDER BY points DESC, address ASC");
    const entries = rows.map(row => {
      const totalBets = Number(row.won_bets) + Number(row.lost_bets);
      return { ...toApi(row), points: Number(row.points), totalBets, winRate: totalBets ? Number(row.won_bets) / totalBets : 0 };
    });
    return { entries, total: entries.length };
  });
  // Leave readiness to the caller so tests can observe actual pre-serialization payloads.
  return app;
}
