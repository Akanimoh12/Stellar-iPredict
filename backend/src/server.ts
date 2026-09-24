
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { registerLeaderboardRoutes } from "./api/leaderboard.js";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";
import { registerApiRoutes } from "./api/index.js";
import { registerOpenApi } from "./api/openapi.js";
import { healthRoutes, markShuttingDown } from "./api/health.js";
import {
  DEFAULT_CORS_ORIGINS,
  parseCorsOrigins,
  validateCorsAllowlist,
  validateCorsOrigin,
} from "./lib/cors.js";
import { registerErrorHandler, registerNotFoundHandler } from "./lib/errors.js";
import {
  REQUEST_ID_HEADER,
  createLoggerOptions,
  genReqId,
  registerRequestLogging,
} from "./lib/log.js";

import { createMarketsRoutes } from "./api/markets.js";
import { registerStatsRoutes } from "./api/stats.js";
import { registerStatusRoutes } from "./api/status.js";
import { registerOracleRoutes } from "./api/oracle.js";
import { registerRateLimiter } from "./cache/rateLimiter.js";
import { registerMetricsHook, registerMetricsEndpoint } from "./metrics.js";
import { registerCancellationHook } from "./lib/cancellation.js";

// Re-exported so `@/server` stays the entry point callers already import these
// from; they live in lib/cors.ts to keep config/index.ts out of an import cycle.
export {
  DEFAULT_CORS_ORIGINS,
  parseCorsOrigins,
  validateCorsAllowlist,
  validateCorsOrigin,
};

declare module "fastify" {
  interface FastifyInstance {
    /** Every route registered on this instance; see `registeredRoutes` in {@link buildServer}. */
    registeredRoutes: { method: string; url: string }[];
  }
}


/** Default global request body limit (16 KiB), matching the largest legitimate JSON request (issue #473). */
export const DEFAULT_BODY_LIMIT = 16 * 1024;

/**
 * Default connection timeout in milliseconds (10s) — issue #474.
 * Closes stalled or inactive sockets before request headers are sent.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10000;

/**
 * Default request timeout in milliseconds (30s) — issue #474.
 * Sets the maximum allowed time for receiving the complete HTTP request from a client.
 *
 * Dependency on database statement_timeout:
 * Server-side request timeouts cut off slow clients and trigger socket closure, which
 * fires `registerCancellationHook` and cancels queries via `queryWithCancel` (`pg_cancel_backend`).
 * This pairs directly with Postgres's `STATEMENT_TIMEOUT_MS` (db/pool.ts) to guarantee
 * that database connections are released and not held indefinitely by stalled clients.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export interface ServerConfig {
  port: number;
  host: string;
  /** Browser origins allowed to call the API. See {@link parseCorsOrigins}. */
  corsOrigins?: string[];
}

export interface BuildServerOptions {
  corsOrigins?: string[];
  /**
   * Whether to allow credentials (cookies, ambient HTTP authorization).
   * Defaults to false: the API is bearer-token and API-key authenticated.
   * Enabling credentials alongside a permissive or wildcard origin entry will fail startup.
   */
  corsCredentials?: boolean;
  /** Overrides the logger config; tests pass a stream to capture output. */
  logger?: FastifyServerOptions["logger"];
  /** Required PostgreSQL connection pool (issue #471). */
  pool: Pool;
  /** Redis client for cache-aside reads. When omitted, routes hit the DB directly. */
  redis?: Redis;
  /** Global request body limit in bytes. Defaults to 16 KiB (issue #473). */
  bodyLimit?: number;
  /** Connection timeout in milliseconds. Defaults to 10s (issue #474). */
  connectionTimeout?: number;
  /** Request timeout in milliseconds. Defaults to 30s (issue #474). */
  requestTimeout?: number;
}

export interface GracefulShutdownOptions {
  signals?: NodeJS.Signals[];
  exitProcess?: boolean;
  shutdownDatabase?: boolean;
  shutdownDatabaseFn?: () => Promise<void>;
  /**
   * Upper bound, in ms, on how long shutdown waits for in-flight requests to
   * drain before forcing the HTTP server closed. Must be kept shorter than
   * the orchestrator's grace period (e.g. Kubernetes `terminationGracePeriodSeconds`)
   * or the orchestrator sends SIGKILL first and this timeout never gets to run.
   */
  drainTimeoutMs?: number;
}

/** Default drain timeout — comfortably inside a typical 30s orchestrator grace period. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const databasePool = options.pool;
  const redis = options.redis;
  const corsCredentials = options.corsCredentials ?? false;
  const allowedOrigins =
    options.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGINS, { credentials: corsCredentials });

  // Validate allowed origins against credentials and format rules at startup
  validateCorsAllowlist(allowedOrigins, { credentials: corsCredentials });

  const server = Fastify({
    logger: options.logger ?? createLoggerOptions(),
    genReqId,
    // The onResponse hook in registerRequestLogging is the single per-request
    // log line; Fastify's built-in pair would just duplicate it.
    disableRequestLogging: true,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    connectionTimeout: options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    requestTimeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  // Independent record of every route ever registered, regardless of where in
  // this function it happens — added before anything else so it can't miss a
  // route the way the OpenAPI spec generator's onRoute hook can if a plugin is
  // registered above it. Exists purely so tests can diff the spec against the
  // real route table (#476); not meant for runtime use.
  const registeredRoutes: { method: string; url: string }[] = [];
  server.addHook("onRoute", (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const method of methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      registeredRoutes.push({ method, url: opts.url });
    }
  });
  server.decorate("registeredRoutes", registeredRoutes);

  registerRequestLogging(server);
  registerMetricsHook(server);
  registerMetricsEndpoint(server);
  // Exposes request.abortSignal, which read-only GET routes pass into
  // queryWithCancel (db/pool.ts) so a disconnecting client's query gets
  // cancelled at the Postgres level instead of running to completion (#475).
  registerCancellationHook(server);
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

  // Response compression - supports gzip and brotli (when available)
  // Should be registered after security headers but before CORS and routes
  server.register(compress, {
    global: true,
    threshold: 1024, // Don't compress responses smaller than 1KB
  });


  // CORS: allowlist only, never a reflected wildcard.
  // Security rationale (issue #472):
  // Credentials (cookies / HTTP auth headers) are disabled by default (`corsCredentials: false`).
  // The API is bearer-token and API-key authenticated via request headers, so cookies
  // and ambient credentials are not required. Disabling credentials eliminates the risk of
  // cross-origin credential theft and CSRF-style credential-leaking attacks.
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
    credentials: corsCredentials,
    maxAge: 86400,
  });

  // OpenAPI spec at /api/docs. Every route plugin below must be registered
  // after this: registerOpenApi's onRoute hook only sees routes registered
  // after it is attached, so anything registered above it silently disappears
  // from the generated spec (#476).
  registerOpenApi(server);

  registerLeaderboardRoutes(server, databasePool, redis);
  registerStatsRoutes(server, databasePool, redis);
  registerOracleRoutes(server, databasePool);

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

    createMarketsRoutes(routes, databasePool, redis);
  });

  // Readiness probe: verifies DB and Redis are reachable.
  server.register(healthRoutes);

  // Public status feed for an external status page. Unversioned alongside the
  // probes: it publishes operational signals, not the client API contract.
  registerStatusRoutes(server, databasePool, redis);

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
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let isShuttingDown = false;

  // Tracked so a forced closure can log exactly what was still in flight,
  // rather than just "something was stuck".
  const inFlightRequestIds = new Set<string>();
  server.addHook("onRequest", async (request) => {
    inFlightRequestIds.add(request.id);
  });
  server.addHook("onResponse", async (request) => {
    inFlightRequestIds.delete(request.id);
  });
  server.addHook("onError", async (request) => {
    inFlightRequestIds.delete(request.id);
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    // Flips readiness to "not ready" before anything else, so the load
    // balancer stops routing new traffic here while draining proceeds.
    markShuttingDown();
    server.log.info({ signal, drainTimeoutMs }, "Graceful shutdown started");

    let failure: unknown;
    let timedOut = false;

    const closePromise = server.close();
    const drainTimeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, drainTimeoutMs).unref();
    });

    try {
      await Promise.race([closePromise, drainTimeout]);
    } catch (error) {
      failure = error;
      server.log.error({ err: error, signal }, "Error closing HTTP server during shutdown");
    }

    if (timedOut) {
      server.log.error(
        {
          signal,
          drainTimeoutMs,
          outstandingRequestCount: inFlightRequestIds.size,
          outstandingRequestIds: [...inFlightRequestIds],
        },
        "Drain timeout elapsed with requests still in flight; forcing the server closed"
      );

      // Node 18.2+: drops every open socket immediately, letting the close()
      // call above finally settle instead of hanging past the deadline.
      const rawServer = server.server as unknown as { closeAllConnections?: () => void };
      rawServer.closeAllConnections?.();
      closePromise.catch(() => {});

      failure ??= new Error(`Shutdown drain timeout of ${drainTimeoutMs}ms exceeded`);
    }

    if (shutdownDatabase) {
      try {
        const shutdownFn = options.shutdownDatabaseFn ?? (await import("./db/pool.js")).shutdown;
        await shutdownFn();
      } catch (error) {
        failure ??= error;
        server.log.error({ err: error, signal }, "Error closing database pool during shutdown");
      }
    }

    if (failure) {
      server.log.error({ err: failure, signal }, "Graceful shutdown failed");
      if (exitProcess) {
        process.exit(1);
      }
    } else {
      server.log.info({ signal }, "Graceful shutdown complete");
      if (exitProcess) {
        process.exit(0);
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
