import type { MaintenanceState } from "../lib/maintenance.js";

/**
 * Augment Fastify's instance type with application-level decorations.
 *
 * Adding types here (instead of inline casts) lets TypeScript check every
 * access to the decorated property throughout the codebase.
 */
declare module "fastify" {
  interface FastifyInstance {
    /**
     * Maintenance mode state holder, available after buildServer mounts it.
     * Undefined when no Redis client is passed to buildServer (e.g. some tests).
     */
    maintenanceState?: MaintenanceState;
  }
}
