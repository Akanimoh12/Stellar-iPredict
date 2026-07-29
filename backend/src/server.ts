
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { registerLeaderboardRoutes } from "./api/leaderboard.js";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { registerApiRoutes } from "./api/index.js";
import { registerOpenApi } from "./api/openapi.js";
import { healthRoutes } from "./api/health.js";
import { DEFAULT_CORS_ORIGINS, parseCorsOrigins } from "./lib/cors.js";
import { registerErrorHandler, registerNotFoundHandler } from "./lib/errors.js";
import {
  REQUEST_ID_HEADER,
  createLoggerOptions,
  genReqId,
  registerRequestLogging,
} from "./lib/log.js";

import { createMarketsRoutes } from "./api/markets.js";
import { registerStatsRoutes } from "./api/stats.js";
import { registerRateLimiter } from "./cache/rateLimiter.js";

// Re-exported so `@/server` stays the entry point callers already import these
// from; they live in lib/cors.ts to keep config/index.ts out of an import cycle.
export { DEFAULT_CORS_ORIGINS, parseCorsOrigins };


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
  pool?: Pool;
  /** Redis client for cache-aside reads. When omitted, routes hit the DB directly. */
  redis?: Redis;
}

export interface GracefulShutdownOptions {
  signals?: NodeJS.Signals[];
  exitProcess?: boolean;
  shutdownDatabase?: boolean;
  shutdownDatabaseFn?: () => Promise<void>;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const databasePool = options.pool as any;
  const redis = options.redis;
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

  // One error envelope for every failure, including unknown routes and methods.
  // Registered before anything adds a route: the 404/405 handler learns which
  // methods a path accepts from an onRoute hook, which only sees later routes.
  registerNotFoundHandler(server);

  // Per-route rate limiting — runs early so abusive clients are rejected
  // before any route handler or downstream middleware does real work.
  registerRateLimiter(server);


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


  registerLeaderboardRoutes(server, databasePool, redis);
  registerStatsRoutes(server, databasePool, redis);

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
    exposedHeaders: [
      REQUEST_ID_HEADER,
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
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

    createMarketsRoutes(routes, undefined, redis);
  });

  // Readiness probe: verifies DB and Redis are reachable.
  server.register(healthRoutes);

  // Feature routes, all of them under /api/v1. Health checks stay unversioned:
  // they are infrastructure, not part of the contract clients code against.
  registerApiRoutes(server);


  return server;
}


export function registerGracefulShutdown(
  server: FastifyInstance,
  options: GracefulShutdownOptions = {}
): void {
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  const exitProcess = options.exitProcess ?? true;
  const shutdownDatabase = options.shutdownDatabase ?? true;
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    server.log.info({ signal }, "Graceful shutdown started");

    try {
      await server.close();
      if (shutdownDatabase) {
        const shutdownFn = options.shutdownDatabaseFn ?? (await import("./db/pool.js")).shutdown;
        await shutdownFn();
      }
      server.log.info({ signal }, "Graceful shutdown complete");
      if (exitProcess) {
        process.exit(0);
      }
    } catch (error) {
      server.log.error({ err: error, signal }, "Graceful shutdown failed");
      if (exitProcess) {
        process.exit(1);
      }
    }
  };

  for (const signal of signals) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const { pool } = await import("./db/pool.js");
  const server = buildServer({ corsOrigins: config.corsOrigins, pool });

  registerGracefulShutdown(server);

  await server.listen({ port: config.port, host: config.host });

  return server;
}
