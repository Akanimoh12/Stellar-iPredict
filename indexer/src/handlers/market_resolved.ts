import { invalidateOnMarketResolved } from "../cache.js";
import { marketResolvedPayloadSchema, type MarketResolvedPayload } from "../schemas.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";
import { insertProcessedEvent } from "./idempotency.js";

export const MARKET_RESOLVED_TOPIC = ["market_resolved"] as const;
export const LEGACY_MARKET_RESOLVED_TOPIC = ["mkt", "resolved"] as const;

export function decodeMarketResolvedEvent(event: Pick<DecodedContractEvent, "topics" | "data">): MarketResolvedPayload {
  const [domain, action] = event.topics;
  const isMarketResolvedTopic =
    domain === MARKET_RESOLVED_TOPIC[0] ||
    (domain === LEGACY_MARKET_RESOLVED_TOPIC[0] && action === LEGACY_MARKET_RESOLVED_TOPIC[1]);

  if (!isMarketResolvedTopic) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  return marketResolvedPayloadSchema.parse(event.data);
}

export async function handleMarketResolvedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<MarketResolvedPayload> {
  const payload = decodeMarketResolvedEvent(event);

  const inserted = await insertProcessedEvent(db, {
    event,
    eventType: "market_resolved",
    marketId: payload.market_id,
    payload: JSON.stringify(payload),
  });
  if (!inserted) return payload;

  await db.query(
    `UPDATE markets
     SET resolved = TRUE,
         outcome = $2,
         cancelled = FALSE,
         updated_at = NOW()
     WHERE id = $1`,
    [payload.market_id, payload.outcome],
  );

  await invalidateOnMarketResolved(redis, payload.market_id);

  return payload;
}
