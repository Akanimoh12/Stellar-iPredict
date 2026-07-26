import Redis from "ioredis";
import { config } from "../config/index.js";
import type { HealthCheckResult } from "./health.js";

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
      enableReadyCheck: true,
    });
  }
  return client;
}

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

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
