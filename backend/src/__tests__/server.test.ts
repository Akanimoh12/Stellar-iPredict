import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerGracefulShutdown } from "../server.js";

describe("registerGracefulShutdown", () => {
  it("closes the server once so Fastify stops accepting and drains in-flight requests", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const server = {
      close,
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as FastifyInstance;

    registerGracefulShutdown(server, {
      signals: ["SIGUSR2"],
      exitProcess: false,
      shutdownDatabase: false,
    });

    process.emit("SIGUSR2", "SIGUSR2");
    process.emit("SIGUSR2", "SIGUSR2");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
