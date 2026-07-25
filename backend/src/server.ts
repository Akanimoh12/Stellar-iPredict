import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerLeaderboardRoutes } from "./api/leaderboard.js";

export interface ServerConfig {
  port: number;
  host: string;
}

export interface BuildServerOptions {
  pool?: Pool;
}

export interface GracefulShutdownOptions {
  signals?: NodeJS.Signals[];
  exitProcess?: boolean;
  shutdownDatabase?: boolean;
  shutdownDatabaseFn?: () => Promise<void>;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: true });
  if (!options.pool) {
    throw new Error("buildServer requires a database pool");
  }
  const databasePool = options.pool;

  server.get("/healthz", async (_req, reply) => {
    reply.status(200).send({ status: "ok" });
  });

  registerLeaderboardRoutes(server, databasePool);

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
        const shutdown = options.shutdownDatabaseFn ?? (await import("./db/pool.js")).shutdown;
        await shutdown();
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
  const server = buildServer({ pool });

  registerGracefulShutdown(server);

  await server.listen({ port: config.port, host: config.host });

  return server;
}
