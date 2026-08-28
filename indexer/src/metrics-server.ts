import { createServer, type Server } from "http";
import { serializeMetrics } from "./metrics.js";

const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9090);

/**
 * Simple HTTP server that exposes Prometheus metrics at GET /metrics.
 *
 * Defaults to port 9090 but respects the METRICS_PORT environment variable.
 */
export class MetricsServer {
  private server: Server | null = null;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/metrics") {
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
          res.end(serializeMetrics());
        } else if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      });

      this.server.listen(METRICS_PORT, "127.0.0.1", () => {
        resolve();
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
