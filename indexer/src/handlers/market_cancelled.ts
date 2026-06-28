import { marketCancelledPayloadSchema, type MarketCancelledPayload } from "../schemas.js";
import { invalidateMarketCache } from "../cache.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

export const MARKET_CANCELLED_TOPIC = ["mkt", "cancelled"] as const;

export function decodeMarketCancelledEvent(event: Pick<DecodedContractEvent, "topics" | "data">): MarketCancelledPayload {
  const [domain, action] = event.topics;
  if (domain !== MARKET_CANCELLED_TOPIC[0] || action !== MARKET_CANCELLED_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  return marketCancelledPayloadSchema.parse(event.data);
}

export async function handleMarketCancelledEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<MarketCancelledPayload> {
  const payload = decodeMarketCancelledEvent(event);

  await db.query(
    `UPDATE markets
     SET cancelled = TRUE,
         resolved = FALSE,
         outcome = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [payload.market_id],
  );

  await invalidateMarketCache(redis, payload.market_id);

  return payload;
}
