import { createServer, type Server } from "node:http";
import type { Logger } from "../log.js";

export interface DependencyCheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ReadinessCheckResult {
  db: DependencyCheckResult;
  rpc: DependencyCheckResult;
}

export interface AggregatorHealthServerOptions {
  port: number;
  host: string;
  getLastPollCompletedAt: () => number | null;
  maxStaleMs: number;
  checkReadiness: () => Promise<ReadinessCheckResult>;
  logger?: Logger;
}

export class AggregatorHealthServer {
  private server: Server | null = null;

  constructor(private readonly options: AggregatorHealthServerOptions) {}

  address(): { address: string; port: number } | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return { address: address.address, port: address.port };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        const path = (request.url ?? "").split("?")[0];

        if (request.method === "GET" && (path === "/health/live" || path === "/live" || path === "/livez")) {
          const lastPoll = this.options.getLastPollCompletedAt();
          const now = Date.now();
          const isStale = lastPoll === null || (now - lastPoll > this.options.maxStaleMs);
          const ageMs = lastPoll !== null ? now - lastPoll : undefined;

          const body = JSON.stringify({
            status: isStale ? "dead" : "live",
            lastPollCompletedAt: lastPoll,
            ageMs,
            maxStaleMs: this.options.maxStaleMs,
          });

          response.writeHead(isStale ? 503 : 200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          });
          response.end(body);
          return;
        }

        if (request.method === "GET" && (path === "/health/ready" || path === "/ready" || path === "/readyz")) {
          try {
            const timeoutFallback: ReadinessCheckResult = {
              db: { ok: false, error: "Readiness check timed out" },
              rpc: { ok: false, error: "Readiness check timed out" },
            };
            const checks = await Promise.race([
              this.options.checkReadiness(),
              new Promise<ReadinessCheckResult>((resolve) =>
                setTimeout(() => resolve(timeoutFallback), 3_000),
              ),
            ]);

            const ready = checks.db.ok && checks.rpc.ok;
            const body = JSON.stringify({
              status: ready ? "ready" : "not ready",
              checks,
            });

            response.writeHead(ready ? 200 : 503, {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            });
            response.end(body);
          } catch (error) {
            const errStr = error instanceof Error ? error.message : String(error);
            const body = JSON.stringify({
              status: "not ready",
              error: errStr,
            });
            response.writeHead(503, {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            });
            response.end(body);
          }
          return;
        }

        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not Found\n");
      });

      const onStartupError = (error: Error) => reject(error);
      server.once("error", onStartupError);

      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onStartupError);
        this.server = server;
        this.options.logger?.info("aggregator health server started", {
          host: this.options.host,
          port: this.options.port,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
    this.options.logger?.info("aggregator health server stopped");
  }
}
