import { parseEventPayload, type MarketCreatedPayload } from "../schemas.js";
import { invalidateOnMarketCreated } from "../cache.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";
import { insertProcessedEvent } from "./idempotency.js";
import {
  sanitizeMarketQuestion,
  sanitizeMarketCategory,
  sanitizeImageUrl,
} from "../lib/sanitize.js";

export const MARKET_CREATED_TOPIC = ["mkt", "created"] as const;

export function decodeMarketCreatedEvent(event: Pick<DecodedContractEvent, "topics" | "data">): MarketCreatedPayload {
  const [domain, action] = event.topics;
  if (domain !== MARKET_CREATED_TOPIC[0] || action !== MARKET_CREATED_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  return parseEventPayload("market_created", event.data);
}

export async function handleMarketCreatedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<MarketCreatedPayload> {
  const payload = decodeMarketCreatedEvent(event);

  const inserted = await insertProcessedEvent(db, {
    event,
    eventType: "market_created",
    marketId: payload.market_id,
    actor: payload.creator,
    payload: JSON.stringify(payload),
  });
  if (!inserted) return payload;

  // Sanitize all text fields at the boundary before storage
  const sanitizedQuestion = sanitizeMarketQuestion(payload.question);
  const sanitizedCategory = sanitizeMarketCategory(payload.category);
  const sanitizedImageUrl = sanitizeImageUrl(payload.image_url);

  await db.query(
    `INSERT INTO markets (id, question, image_url, category, end_time, creator, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       question = EXCLUDED.question,
       image_url = COALESCE(EXCLUDED.image_url, markets.image_url),
       category = EXCLUDED.category,
       end_time = EXCLUDED.end_time,
       creator = EXCLUDED.creator,
       updated_at = NOW()`,
    [
      payload.market_id,
      sanitizedQuestion,
      sanitizedImageUrl,
      sanitizedCategory,
      payload.end_time,
      payload.creator,
    ],
  );

  await invalidateOnMarketCreated(redis);

  return payload;
}
