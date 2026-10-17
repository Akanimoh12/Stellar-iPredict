import { createServer, type Server } from "http";
import { serializeMetrics } from "./metrics.js";
import { checkLiveness, checkReadiness, type HealthCheckDeps } from "./health.js";

const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9090);
// Bind address for the metrics server. Defaults to 0.0.0.0 so that a
// Prometheus running outside this process can actually reach the endpoint —
// the infra monitoring stack (infra/docker-compose.monitoring.yml) scrapes
// host-run services via host.docker.internal, which arrives on a non-loopback
// interface. Override with METRICS_HOST when the endpoint must stay private.
const METRICS_HOST = process.env.METRICS_HOST ?? "0.0.0.0";

/**
 * HTTP server that exposes:
 * - GET /metrics: Prometheus metrics
 * - GET /health/live: Liveness probe (poll loop progress)
 * - GET /health/ready: Readiness probe (dependencies + lag)
 *
 * Defaults to port 9090 but respects the METRICS_PORT environment variable,
 * and binds 0.0.0.0 unless METRICS_HOST says otherwise.
 */
export class MetricsServer {
  private server: Server | null = null;
  private healthDeps: HealthCheckDeps | null = null;

  constructor(healthDeps?: HealthCheckDeps) {
    this.healthDeps = healthDeps || null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/metrics") {
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
          res.end(serializeMetrics());
        } else if (req.method === "GET" && req.url === "/health/live") {
          const liveness = checkLiveness();
          const statusCode = liveness.status === "ok" ? 200 : 503;
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(liveness));
        } else if (req.method === "GET" && req.url === "/health/ready") {
          if (!this.healthDeps) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "unhealthy", message: "health dependencies not configured" }));
            return;
          }
          const readiness = await checkReadiness(this.healthDeps);
          const statusCode = readiness.status === "ok" ? 200 : readiness.status === "degraded" ? 200 : 503;
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(readiness));
        } else if (req.method === "GET" && req.url === "/health") {
          // Legacy endpoint for backward compatibility
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      });

      this.server.listen(METRICS_PORT, METRICS_HOST, () => {
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
