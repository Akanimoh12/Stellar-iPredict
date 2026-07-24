import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

export interface ServerConfig {
  port: number;
  host: string;
  /** Browser origins allowed to call the API. See {@link parseCorsOrigins}. */
  corsOrigins?: string[];
}

export interface BuildServerOptions {
  corsOrigins?: string[];
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

  const server = Fastify({ logger: true });

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
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400,
  });

  server.get("/healthz", async (_req, reply) => {
    reply.status(200).send({ status: "ok" });
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
