import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";

/**
 * OpenAPI document for the API.
 *
 * The spec is generated from the JSON schemas already attached to each route
 * rather than hand-written, so documenting a new endpoint is a side effect of
 * giving it a `schema` — the two cannot drift apart.
 */

/** Route the generated document is served from. */
export const DOCS_ROUTE = "/api/docs";

export const OPENAPI_VERSION = "3.1.0";

export interface OpenApiOptions {
  /** Version reported in `info.version`. Defaults to the package version. */
  version?: string;
}

const DESCRIPTION = [
  "REST API serving market, bet, leaderboard and stats data to the iPredict",
  "frontend, read from an indexed PostgreSQL copy of on-chain Soroban state.",
].join(" ");

/** Base document; paths are filled in by @fastify/swagger from route schemas. */
export function buildOpenApiDocument(options: OpenApiOptions = {}) {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "iPredict API",
      description: DESCRIPTION,
      version: options.version ?? "0.1.0",
    },
    tags: [
      { name: "system", description: "Liveness and readiness probes" },
      { name: "markets", description: "Prediction markets and their bets" },
      { name: "leaderboard", description: "Player rankings" },
      { name: "stats", description: "Global platform statistics" },
      { name: "oracle", description: "Oracle provider submissions" },
    ],
    components: {
      securitySchemes: {
        oracleApiKey: {
          type: "http" as const,
          scheme: "bearer",
          description: "Oracle provider API key, for `POST /api/oracle/*`.",
        },
      },
    },
  };
}

/**
 * Registers spec generation and serves the document as JSON at `/api/docs`.
 *
 * Kept JSON-only: a bundled Swagger UI would need script-src exceptions in the
 * security headers set for #71, and the spec is what tooling consumes anyway.
 */
export function registerOpenApi(app: FastifyInstance, options: OpenApiOptions = {}): void {
  app.register(swagger, { openapi: buildOpenApiDocument(options) });

  // Nested so it loads after the plugin above and lands in the spec itself.
  app.register(async (routes) => {
    routes.get(
      DOCS_ROUTE,
      {
        schema: {
          summary: "OpenAPI specification for this API",
          tags: ["system"],
          response: {
            200: {
              type: "object",
              additionalProperties: true,
              properties: {
                openapi: { type: "string" },
              },
              required: ["openapi"],
            },
          },
        },
      },
      async (_request, reply) => {
        reply.type("application/json").send(routes.swagger());
      }
    );
  });
}
