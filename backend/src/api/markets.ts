import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";

import { badRequest, notFound } from "../lib/errors.js";
import { getMarketById, getMarkets, type Queryable, type MarketCategory } from "../db/markets.js";
import { getOrSet } from "../cache/cacheAside.js";
import {
  marketKey,
  marketsListKey,
} from "../cache/cacheKeys.js";

type MarketParams = {
  id: string;
};

// TTLs in seconds — mirrors docs/ORACLE_AND_BACKEND.md §Caching Strategy
const MARKET_DETAIL_TTL = 30;
const MARKETS_ACTIVE_TTL = 15;
const MARKETS_DEFAULT_TTL = 30;

export function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

const VALID_CATEGORIES = [
  "Crypto",
  "Sports",
  "Politics",
  "Entertainment",
  "Science",
] as const;

const categorySchema = z
  .string()
  .optional()
  .transform((val: string | undefined): MarketCategory | undefined => {
    if (!val) return undefined;
    // Trim whitespace
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    // Convert to TitleCase (first letter uppercase, rest lowercase)
    const normalized =
      trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
    return normalized as MarketCategory;
  })
  .refine((val: MarketCategory | undefined) => {
    if (!val) return true;
    return VALID_CATEGORIES.includes(val);
  }, {
    message: "Invalid category. Must be one of: Crypto, Sports, Politics, Entertainment, Science",
  });

const marketsQuerySchema = z.object({
  filter: z
    .enum(["active", "resolved", "ended", "cancelled", "all"])
    .default("all"),
  category: categorySchema,
  sort: z
    .enum(["newest", "volume", "ending_soon", "bettors"])
    .default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const marketResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "number" },
    question: { type: "string" },
    image_url: { type: ["string", "null"] },
    category: { type: "string" },
    end_time: { type: "string" },
    total_yes: { type: "string" },
    total_no: { type: "string" },
    resolved: { type: "boolean" },
    outcome: { type: ["boolean", "null"] },
    cancelled: { type: "boolean" },
    creator: { type: "string" },
    bet_count: { type: "number" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "question",
    "image_url",
    "category",
    "end_time",
    "total_yes",
    "total_no",
    "resolved",
    "outcome",
    "cancelled",
    "creator",
    "bet_count",
    "created_at",
    "updated_at",
  ],
} as const;

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
} as const;

export function createMarketsRoutes(
  app: FastifyInstance,
  db?: Queryable,
  redis?: Redis
): void {
  // ── GET /api/markets ──────────────────────────────────────────────────────
  app.get(
    "/api/markets",
    {
      schema: {
        summary: "List markets with filtering, sorting and pagination",
        tags: ["markets"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            filter: {
              type: "string",
              enum: ["active", "resolved", "ended", "cancelled", "all"],
              description: "Filter markets by status",
            },
            category: {
              type: "string",
              description: "Filter by market category. Accepts: Crypto, Sports, Politics, Entertainment, Science. Case-insensitive and whitespace-trimming.",
            },
            sort: {
              type: "string",
              enum: ["newest", "volume", "ending_soon", "bettors"],
              description: "Sort order",
            },
            page: {
              type: "integer",
              minimum: 1,
              description: "Page number (1-indexed)",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Results per page",
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            properties: {
              markets: { type: "array", items: marketResponseSchema },
              total: { type: "number" },
              page: { type: "number" },
              limit: { type: "number" },
            },
            required: ["markets", "total", "page", "limit"],
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = marketsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid query parameters",
            issues: parsed.error.issues,
          },
        });
      }

      const { filter, category, sort, page, limit } = parsed.data;

      const key = marketsListKey(filter, category, sort, page, limit);
      const ttl =
        filter === "active" ? MARKETS_ACTIVE_TTL : MARKETS_DEFAULT_TTL;

      const result = redis
        ? await getOrSet(redis, key, ttl, () =>
            getMarkets({ filter, category, sort, page, limit }, db)
          )
        : await getMarkets({ filter, category, sort, page, limit }, db);

      return reply.status(200).send({
        markets: result.rows ?? [],
        total: result.total ?? 0,
        page: result.page,
        limit: result.limit,
      });
    }
  );

  // ── GET /api/markets/:id ──────────────────────────────────────────────────
  app.get<{ Params: MarketParams }>(
    "/api/markets/:id",
    {
      schema: {
        summary: "Get details of a market from its ID",
        tags: ["markets"],
        params: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Positive integer market id" },
          },
          required: ["id"],
        },
        response: {
          200: marketResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const id = parsePositiveInteger(request.params.id);
      if (id === null) {
        throw badRequest("id must be a positive integer");
      }

      const loader = () => getMarketById(id, db);
      const market = redis
        ? await getOrSet(redis, marketKey(id), MARKET_DETAIL_TTL, loader)
        : await loader();

      if (!market) {
        throw notFound("Market not found");
      }

      return market;
    }
  );
}
