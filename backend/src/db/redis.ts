import type { HealthCheckResult } from "./health.js";
import { getRedisClient } from "../cache/redis.js";

// The connection is owned by `cache/redis.ts`; these are re-exported so existing
// callers (server startup and shutdown) keep importing from `db/redis`.
export { closeRedis, getRedisClient } from "../cache/redis.js";

export async function pingRedis(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    if (pong !== "PONG") {
      return { ok: false, error: `Unexpected PING response: ${pong}` };
    }
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
