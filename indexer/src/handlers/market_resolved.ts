import { invalidateLeaderboardCache, invalidateMarketCache } from "../cache.js";
import { marketResolvedPayloadSchema, type MarketResolvedPayload } from "../schemas.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

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

  await db.query(
    `INSERT INTO events (ledger_seq, tx_hash, event_type, market_id, actor, payload)
     SELECT $1, $2, $3, $4, NULL, $5::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM events
       WHERE ledger_seq = $1
         AND tx_hash = $2
         AND event_type = $3
         AND market_id = $4
     )`,
    [
      event.ledger,
      event.txHash,
      "market_resolved",
      payload.market_id,
      JSON.stringify(payload),
    ],
  );

  await db.query(
    `UPDATE markets
     SET resolved = TRUE,
         outcome = $2,
         cancelled = FALSE,
         updated_at = NOW()
     WHERE id = $1`,
    [payload.market_id, payload.outcome],
  );

  await invalidateMarketCache(redis, payload.market_id);
  await invalidateLeaderboardCache(redis);

  return payload;
}
