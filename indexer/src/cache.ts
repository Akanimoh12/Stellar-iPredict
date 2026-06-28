import type { RedisClient } from "./types.js";

export async function invalidateMarketCache(redis: RedisClient, marketId: number): Promise<void> {
  await redis.del(`market:${marketId}`, "markets:all", "markets:active");
}
