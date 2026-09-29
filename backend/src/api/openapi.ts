import type { FastifyInstance } from "fastify";
import Ajv from "ajv";
import addFormats from "ajv-formats";
const validators = new WeakMap<object, Ajv>();

// ── JSON Schemas for Entities & API Responses ─────────────────────────────────

export const ErrorResponseSchema = {
  $id: "ErrorResponse",
  type: "object",
  required: ["statusCode", "error", "message"],
  additionalProperties: false,
  properties: {
    statusCode: { type: "integer", example: 400 },
    error: { type: "string", example: "Bad Request" },
    message: { type: "string", example: "Invalid parameter provided" },
  },
} as const;

export const HealthResponseSchema = {
  $id: "HealthResponse",
  type: "object",
  required: ["status", "timestamp", "version"],
  additionalProperties: false,
  properties: {
    status: { type: "string", example: "ok" },
    timestamp: { type: "string", example: "2026-09-29T11:00:00.000Z" },
    version: { type: "string", example: "0.1.0" },
  },
} as const;

export const MarketSchema = {
  $id: "Market",
  type: "object",
  required: [
    "id",
    "question",
    "category",
    "endTime",
    "totalYes",
    "totalNo",
    "resolved",
    "cancelled",
    "creator",
    "betCount",
  ],
  additionalProperties: false,
  properties: {
    id: { type: "string", example: "1" },
    question: { type: "string", example: "Will XLM reach $1 in 2026?" },
    imageUrl: { type: "string", nullable: true, example: "https://example.com/xlm.png" },
    category: { type: "string", example: "Crypto" },
    endTime: { type: "integer", example: 1770000000 },
    totalYes: { type: "string", example: "1000.5" },
    totalNo: { type: "string", example: "500.0" },
    resolved: { type: "boolean", example: false },
    outcome: { type: "boolean", nullable: true, example: null },
    cancelled: { type: "boolean", example: false },
    creator: { type: "string", example: "GABC1234567890..." },
    betCount: { type: "integer", example: 42 },
    createdAt: { type: "string", format: "date-time", nullable: true },
    updatedAt: { type: "string", format: "date-time", nullable: true },
  },
} as const;

export const MarketListSchema = {
  $id: "MarketList",
  type: "object",
  required: ["markets", "total", "page", "limit"],
  additionalProperties: false,
  properties: {
    markets: {
      type: "array",
      items: MarketSchema,
    },
    total: { type: "integer", example: 1 },
    page: { type: "integer", example: 1 },
    limit: { type: "integer", example: 20 },
  },
} as const;

export const BetSchema = {
  $id: "Bet",
  type: "object",
  required: ["marketId", "bettor", "netAmount", "grossAmount", "isYes", "claimed", "createdAt"],
  additionalProperties: false,
  properties: {
    marketId: { type: "string", example: "1" },
    bettor: { type: "string", example: "GXYZ987654321..." },
    netAmount: { type: "string", example: "9.8" },
    grossAmount: { type: "string", example: "10.0" },
    isYes: { type: "boolean", example: true },
    claimed: { type: "boolean", example: false },
    createdAt: { type: "string", example: "2026-09-29T10:00:00.000Z" },
  },
} as const;

export const BetListSchema = {
  $id: "BetList",
  type: "object",
  required: ["bets", "total"],
  additionalProperties: false,
  properties: {
    bets: {
      type: "array",
      items: BetSchema,
    },
    total: { type: "integer", example: 1 },
  },
} as const;

export const LeaderboardEntrySchema = {
  $id: "LeaderboardEntry",
  type: "object",
  required: ["address", "points", "totalBets", "wonBets", "lostBets", "winRate"],
  additionalProperties: false,
  properties: {
    address: { type: "string", example: "GABC1234567890..." },
    displayName: { type: "string", nullable: true, example: "CryptoKing" },
    points: { type: "integer", example: 350 },
    totalBets: { type: "integer", example: 15 },
    wonBets: { type: "integer", example: 10 },
    lostBets: { type: "integer", example: 5 },
    winRate: { type: "number", example: 0.6667 },
    updatedAt: { type: "string", format: "date-time", nullable: true },
  },
} as const;

export const LeaderboardListSchema = {
  $id: "LeaderboardList",
  type: "object",
  required: ["entries", "total"],
  additionalProperties: false,
  properties: {
    entries: {
      type: "array",
      items: LeaderboardEntrySchema,
    },
    total: { type: "integer", example: 1 },
  },
} as const;

// ── OpenAPI Specification Helper ──────────────────────────────────────────────

export async function getOpenApiSpec(app: FastifyInstance): Promise<any> {
  await app.ready();
  return app.swagger();
}

// ── OpenAPI Response Validation Engine (Ajv) ──────────────────────────────────

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
  schemaFound: boolean;
}

export function validateResponseAgainstSpec(
  spec: any,
  method: string,
  path: string,
  statusCode: number,
  responseBody: any
): ContractValidationResult {
  const normMethod = method.toLowerCase();
  const pathObj = spec.paths?.[path];

  if (!pathObj || !pathObj[normMethod]) {
    return {
      valid: false,
      errors: [`No OpenAPI spec path definition found for [${method.toUpperCase()} ${path}]`],
      schemaFound: false,
    };
  }

  const responseObj = pathObj[normMethod].responses?.[statusCode.toString()];
  if (!responseObj) {
    return {
      valid: false,
      errors: [
        `No declared OpenAPI response schema found for status code ${statusCode} under [${method.toUpperCase()} ${path}]`,
      ],
      schemaFound: false,
    };
  }

  // Extract JSON schema from response object
  const schema = responseObj.content?.["application/json"]?.schema || responseObj.schema;
  if (!schema) {
    return {
      valid: false,
      errors: [`No JSON schema definition found in responses for status ${statusCode} under [${method.toUpperCase()} ${path}]`],
      schemaFound: false,
    };
  }

  let ajv = validators.get(spec);
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validators.set(spec, ajv);
  }
  const pointer = `/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${normMethod}/responses/${statusCode}`;
  let validate = ajv.getSchema(pointer);
  if (!validate) {
    // Establish the document as the base for local OpenAPI component references.
    validate = ajv.compile({ ...schema, $id: pointer, components: spec.components ?? {} });
  }
  const valid = validate(responseBody) as boolean;

  const errors = (validate.errors || []).map(
    (err) => `${err.instancePath || "/"} ${err.message} (${JSON.stringify(err.params)})`
  );

  return { valid, errors, schemaFound: true };
}

// Compare handler output with serialized JSON, including nested arrays and objects.
export interface FieldDroppingResult {
  hasDroppedFields: boolean;
  droppedFields: string[];
}

export function detectDroppedFields(raw: unknown, serialized: unknown): FieldDroppingResult {
  const droppedFields: string[] = [];
  function visit(source: unknown, target: unknown, path: string): void {
    if (!source || typeof source !== "object" || source instanceof Date) return;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const childPath = Array.isArray(source) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      if (!target || typeof target !== "object" || !Object.prototype.hasOwnProperty.call(target, key)) {
        droppedFields.push(childPath);
      } else {
        visit(value, (target as Record<string, unknown>)[key], childPath);
      }
    }
  }
  visit(raw, serialized, "");
  return { hasDroppedFields: droppedFields.length > 0, droppedFields };
}
