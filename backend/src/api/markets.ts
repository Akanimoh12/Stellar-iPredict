import type { FastifyInstance } from "fastify";

import { badRequest, notFound } from "../lib/errors.js";
import { getMarketById, type Queryable } from "../db/markets.js";

type MarketParams = {
  id: string;
};

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

export function createMarketsRoutes(app: FastifyInstance, db?: Queryable): void {
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

      const market = await getMarketById(id, db);
      if (!market) {
        throw notFound("Market not found");
      }

      return market;
    }
  );
}
