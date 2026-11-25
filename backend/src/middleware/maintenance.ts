import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { MaintenanceState, MaintenanceMode } from "../lib/maintenance.js";

/**
 * Maintenance mode middleware.
 *
 * Mounted early in the middleware stack (after health checks, before business
 * routes), this intercepts requests when the backend is in maintenance mode and
 * returns 503 with a `Retry-After` header.
 *
 * - `full` mode: all routes blocked except health probes and admin toggle
 * - `read_only` mode: state-changing methods (POST/PUT/PATCH/DELETE) blocked
 * - `off` mode: pass-through with negligible overhead
 *
 * Blocked requests return:
 * ```
 * HTTP/1.1 503 Service Unavailable
 * Retry-After: 120
 * Content-Type: application/json
 *
 * {"error":"maintenance","mode":"full","retryAfterSeconds":120}
 * ```
 */

const READ_ONLY_ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Routes that must remain accessible even in full maintenance mode
const ALWAYS_ACCESSIBLE_PATHS = new Set([
  "/healthz",
  "/readyz",
  "/admin/maintenance",
]);

export interface MaintenanceMiddlewareOptions {
  state: MaintenanceState;
  retryAfterSeconds: number;
}

function shouldBlock(
  mode: MaintenanceMode,
  method: string,
  path: string
): boolean {
  // Health probes and admin toggle are always accessible
  if (ALWAYS_ACCESSIBLE_PATHS.has(path)) {
    return false;
  }

  if (mode === "full") {
    return true;
  }

  if (mode === "read_only") {
    return !READ_ONLY_ALLOWED_METHODS.has(method);
  }

  return false;
}

export function registerMaintenanceMiddleware(
  app: FastifyInstance,
  options: MaintenanceMiddlewareOptions
): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const mode = await options.state.getMode();

    if (shouldBlock(mode, request.method, request.url)) {
      reply.header("Retry-After", options.retryAfterSeconds.toString());
      reply.status(503).send({
        error: "maintenance",
        mode,
        retryAfterSeconds: options.retryAfterSeconds,
      });
    }
  });
}
