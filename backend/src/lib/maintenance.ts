import type { Redis } from "ioredis";

/**
 * Maintenance mode state management.
 *
 * The backend can be put into maintenance mode to gracefully handle downtime or
 * restrict writes during sensitive operations. Three modes are supported:
 *
 * - `off`: normal operation, all routes work
 * - `read_only`: GET/HEAD/OPTIONS pass, state-changing methods return 503
 * - `full`: all routes except health probes and admin toggle return 503
 *
 * The mode is stored in Redis at key `maintenance:mode` so it persists across
 * restarts and applies consistently to all backend instances. When Redis is
 * unavailable, the mode falls back to the configured default (typically `off`).
 */

export type MaintenanceMode = "off" | "read_only" | "full";

const REDIS_KEY = "maintenance:mode";
const VALID_MODES: readonly MaintenanceMode[] = ["off", "read_only", "full"];

function isValidMode(value: unknown): value is MaintenanceMode {
  return typeof value === "string" && VALID_MODES.includes(value as MaintenanceMode);
}

export interface MaintenanceState {
  /**
   * Returns the current maintenance mode.
   * Falls back to `defaultMode` if Redis is unavailable or returns invalid data.
   */
  getMode(): Promise<MaintenanceMode>;

  /**
   * Sets the maintenance mode.
   * Throws if the mode is invalid or Redis write fails.
   */
  setMode(mode: MaintenanceMode): Promise<void>;
}

export function createMaintenanceState(
  redis: Redis,
  defaultMode: MaintenanceMode
): MaintenanceState {
  return {
    async getMode(): Promise<MaintenanceMode> {
      try {
        const value = await redis.get(REDIS_KEY);
        if (value !== null && isValidMode(value)) {
          return value;
        }
        return defaultMode;
      } catch (error) {
        // Redis unavailable — fall back to default so the app stays operational
        return defaultMode;
      }
    },

    async setMode(mode: MaintenanceMode): Promise<void> {
      if (!isValidMode(mode)) {
        throw new Error(`Invalid maintenance mode: ${mode}. Must be one of: ${VALID_MODES.join(", ")}`);
      }
      await redis.set(REDIS_KEY, mode);
    },
  };
}
