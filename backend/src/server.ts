import Fastify, { type FastifyInstance } from "fastify";

export interface ServerConfig {
  port: number;
  host: string;
}

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/healthz", async (_req, reply) => {
    reply.status(200).send({ status: "ok" });
  });

  return server;
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const server = buildServer();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await server.listen({ port: config.port, host: config.host });

  return server;
}
