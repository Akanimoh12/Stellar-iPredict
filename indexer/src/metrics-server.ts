import { createServer, type Server } from "http";
import { HeapMonitor } from "@ipredict/shared";
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
 * - GET /metrics: Prometheus metrics, including the heap growth trend (#635)
 * - GET /debug/heap: current heap trend as JSON
 * - POST /debug/heap-snapshot: capture a V8 heap snapshot (#635)
 * - GET /health/live: Liveness probe (poll loop progress)
 * - GET /health/ready: Readiness probe (dependencies + lag)
 *
 * The snapshot endpoint writes to `HEAP_SNAPSHOT_DIR` (default
 * `./heap-snapshots`) and is rate-limited by the monitor. Keep METRICS_HOST
 * bound to a private interface if the endpoint is exposed outside the stack.
 */
export class MetricsServer {
  private server: Server | null = null;
  private healthDeps: HealthCheckDeps | null = null;
  private readonly heapMonitor: HeapMonitor;

  constructor(healthDeps?: HealthCheckDeps, heapMonitor?: HeapMonitor) {
    this.healthDeps = healthDeps || null;
    this.heapMonitor =
      heapMonitor ??
      new HeapMonitor({
        service: "indexer",
        onAlert: (assessment) => {
          console.warn("[ipredict-indexer] sustained heap growth detected", {
            growthBytesPerHour: Math.round(assessment.growthBytesPerHour),
            sustainedMs: assessment.sustainedMs,
            sampleCount: assessment.sampleCount,
          });
        },
      });
  }

  /** The monitor fed by this server — useful to tests and diagnostics. */
  getHeapMonitor(): HeapMonitor {
    return this.heapMonitor;
  }

  start(): Promise<void> {
    this.heapMonitor.start();
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && path === "/metrics") {
          const body = [serializeMetrics(), ...this.heapMonitor.serializePrometheus()].join("\n") + "\n";
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
          res.end(body);
        } else if (req.method === "GET" && path === "/debug/heap") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.heapMonitor.assessment()));
        } else if (
          (req.method === "POST" || req.method === "GET") &&
          path === "/debug/heap-snapshot"
        ) {
          const snapshot = this.heapMonitor.writeSnapshot();
          if (snapshot === null) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "rate_limited" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(snapshot));
        } else if (req.method === "GET" && path === "/health/live") {
          const liveness = checkLiveness();
          const statusCode = liveness.status === "ok" ? 200 : 503;
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(liveness));
        } else if (req.method === "GET" && path === "/health/ready") {
          if (!this.healthDeps) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "unhealthy", message: "health dependencies not configured" }));
            return;
          }
          const readiness = await checkReadiness(this.healthDeps);
          const statusCode = readiness.status === "ok" ? 200 : readiness.status === "degraded" ? 200 : 503;
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(readiness));
        } else if (req.method === "GET" && path === "/health") {
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
    this.heapMonitor.stop();
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
