import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { registerOpenApi } from "./api/openapi.js";
import {
  REQUEST_ID_HEADER,
  createLoggerOptions,
  genReqId,
  registerRequestLogging,
} from "./lib/log.js";
import { registerErrorHandler } from "./lib/errors.js";

import { createMarketsRoutes } from "./api/markets.js";

export interface ServerConfig {
  port: number;
  host: string;
  /** Browser origins allowed to call the API. See {@link parseCorsOrigins}. */
  corsOrigins?: string[];
}

export interface BuildServerOptions {
  corsOrigins?: string[];
  /** Overrides the logger config; tests pass a stream to capture output. */
  logger?: FastifyServerOptions["logger"];
}

/** Origin used when `CORS_ORIGINS` is unset — the frontend's dev server. */
export const DEFAULT_CORS_ORIGINS = ["http://localhost:3000"];

/**
 * Parses the `CORS_ORIGINS` env var (comma-separated) into an allowlist.
 *
 * Unset falls back to the local frontend; explicitly empty allows no browser
 * origin at all, which is the right default for a private deployment.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_CORS_ORIGINS];

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const allowedOrigins = options.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGINS);

  const server = Fastify({
    logger: options.logger ?? createLoggerOptions(),
    genReqId,
    // The onResponse hook in registerRequestLogging is the single per-request
    // log line; Fastify's built-in pair would just duplicate it.
    disableRequestLogging: true,
  });

  registerRequestLogging(server);
  registerErrorHandler(server);

  // Security headers. Locked down for a JSON API: nothing is rendered, so every
  // content source is denied and the API cannot be framed.
  server.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      // Without this, helmet merges in its defaults (script-src 'self',
      // style-src 'unsafe-inline', …) which default-src 'none' is meant to deny.
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
        "frame-ancestors": ["'none'"],
      },
    },
    // Responses are meant to be read cross-origin; which origins may actually
    // read them is decided by the CORS allowlist below, not by CORP.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: 15552000, includeSubDomains: true },
    referrerPolicy: { policy: "no-referrer" },
  });

  // CORS: allowlist only, never a reflected wildcard.
  server.register(cors, {
    origin(origin, callback) {
      // No Origin header — curl, health checks, server-to-server. Not a browser
      // cross-origin request, so there is nothing for CORS to protect.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      // Disallowed origins get a normal response with no CORS headers, which is
      // what the browser needs to block the read. Erroring here would break
      // non-browser clients that happen to send an Origin.
      callback(null, allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
    credentials: true,
    maxAge: 86400,
  });

  // OpenAPI spec at /api/docs.
  registerOpenApi(server);

  // Routes go in a plugin registered after registerOpenApi, not directly on the
  // root instance: plugins load in registration order, so this guarantees the
  // spec generator's onRoute hook is listening by the time the routes below are
  // added. Routes added directly would load first and be missing from the spec.
  server.register(async (routes) => {
    routes.get(
      "/healthz",
      {
        schema: {
          summary: "Liveness probe",
          tags: ["system"],
          response: {
            200: {
              type: "object",
              properties: { status: { type: "string" } },
              required: ["status"],
            },
          },
        },
      },
      async (_req, reply) => {
        reply.status(200).send({ status: "ok" });
      }
    );

    createMarketsRoutes(routes);
  });

  return server;
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const server = buildServer({ corsOrigins: config.corsOrigins });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await server.listen({ port: config.port, host: config.host });

  return server;
}
