import type { FastifyPluginAsync } from "fastify";
import type { MaintenanceState, MaintenanceMode } from "../lib/maintenance.js";
import { timingSafeEqual } from "node:crypto";

/**
 * Admin endpoints — privileged operations requiring authentication.
 *
 * These routes are intentionally not registered in the OpenAPI spec to avoid
 * disclosing their existence to unauthenticated callers.
 */

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Always compare same-length strings to avoid timing leak
    timingSafeEqual(Buffer.from(a.padEnd(64, "0")), Buffer.from(b.padEnd(64, "0")));
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface AdminRoutesOptions {
  maintenanceState: MaintenanceState;
  adminSecret?: string;
}

export const createAdminRoutes = (options: AdminRoutesOptions): FastifyPluginAsync => {
  return async (server) => {
    // If no admin secret is configured, do not register admin endpoints
    if (!options.adminSecret) {
      return;
    }

    const authenticate = (authHeader: string | undefined): boolean => {
      if (!authHeader) {
        return false;
      }
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (!match) {
        return false;
      }
      return constantTimeCompare(match[1], options.adminSecret!);
    };

    // GET /admin/maintenance — query current maintenance mode
    server.get("/admin/maintenance", async (request, reply) => {
      if (!authenticate(request.headers.authorization)) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const mode = await options.maintenanceState.getMode();
      return reply.status(200).send({ mode });
    });

    // PUT /admin/maintenance — set maintenance mode
    server.put<{ Body: { mode: MaintenanceMode } }>(
      "/admin/maintenance",
      async (request, reply) => {
        if (!authenticate(request.headers.authorization)) {
          return reply.status(401).send({ error: "Unauthorized" });
        }

        const { mode } = request.body;
        if (!mode || !["off", "read_only", "full"].includes(mode)) {
          return reply.status(400).send({
            error: "Bad Request",
            message: 'mode must be one of: "off", "read_only", "full"',
          });
        }

        const oldMode = await options.maintenanceState.getMode();
        await options.maintenanceState.setMode(mode);

        server.log.warn({
          event: "maintenance_mode_changed",
          oldMode,
          newMode: mode,
          actor: "admin",
        }, "Maintenance mode changed");

        return reply.status(200).send({ mode, previous: oldMode });
      }
    );
  };
};
