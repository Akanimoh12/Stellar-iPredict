import { invalidateOnBetPlaced } from "../cache.js";
import { betPlacedPayloadSchema, type BetPlacedPayload } from "../schemas.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";
import { getEventIndex } from "./idempotency.js";

/** Legacy topic used by the first contract event API. */
export const BET_PLACED_TOPIC = ["bet_placed"] as const;
/** Domain/action topic used by the decoder and cache event contract. */
export const BET_PLACED_DOMAIN_TOPIC = ["bet", "placed"] as const;
/** Compact topic used by earlier indexer event examples. */
export const COMPACT_BET_PLACED_TOPIC = ["bet"] as const;

type TopicPayload = {
  marketId?: unknown;
  bettor?: unknown;
};

function topicPayload(topics: readonly unknown[]): TopicPayload {
  const [domain, action, third, fourth] = topics;

  if (domain === BET_PLACED_TOPIC[0]) {
    return { marketId: action, bettor: third };
  }
  if (domain === BET_PLACED_DOMAIN_TOPIC[0] && action === BET_PLACED_DOMAIN_TOPIC[1]) {
    return { marketId: third, bettor: fourth };
  }
  if (domain === COMPACT_BET_PLACED_TOPIC[0] && action === undefined) {
    return {};
  }

  throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
}

export function isBetPlacedTopic(topics: readonly unknown[]): boolean {
  try {
    topicPayload(topics);
    return true;
  } catch {
    return false;
  }
}

function payloadRecord(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    if (data.length !== 7) {
      throw new Error("bet_placed tuple payload must contain seven fields");
    }
    return {
      market_id: data[0],
      bettor: data[1],
      is_yes: data[2],
      amount: data[3],
      net_amount: data[4],
      fee: data[5],
      is_increase: data[6],
    };
  }

  if (data !== null && typeof data === "object") {
    return { ...(data as Record<string, unknown>) };
  }

  throw new Error("bet_placed payload must be an object or tuple");
}

function mergeTopicField(
  payload: Record<string, unknown>,
  field: "market_id" | "bettor",
  topicValue: unknown,
): void {
  if (topicValue === undefined) return;

  const payloadValue = field === "bettor" ? payload.bettor ?? payload.user : payload.market_id;
  if (payloadValue !== undefined && String(payloadValue) !== String(topicValue)) {
    throw new Error(`bet_placed ${field} does not match its topic value`);
  }

  payload[field] = topicValue;
}

/**
 * Decodes all supported wire shapes into the canonical placement payload.
 *
 * Newer events carry market/user in the payload, while historical
 * `bet_placed` and `bet:placed` topics carry them as topic arguments. We
 * reconcile both forms rather than trusting one silently when they disagree.
 */
export function decodeBetPlacedEvent(
  event: Pick<DecodedContractEvent, "topics" | "data">,
): BetPlacedPayload {
  const topic = topicPayload(event.topics);
  const payload = payloadRecord(event.data);

  mergeTopicField(payload, "market_id", topic.marketId);
  mergeTopicField(payload, "bettor", topic.bettor);

  return betPlacedPayloadSchema.parse(payload);
}

type BetPlacedWriteResult = {
  side_valid: boolean;
  event_inserted: boolean;
  applied: boolean;
};

export async function handleBetPlacedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<BetPlacedPayload> {
  const payload = decodeBetPlacedEvent(event);

  /**
   * The audit write, position upsert, and market aggregate update must be one
   * statement. A separate `events` insert would make a crash after that insert
   * unrecoverable: a replay would dedupe the event while its derived state was
   * still missing. `new_event` therefore gates every downstream CTE.
   *
   * `bets` has one row per bettor/market. `(xmax = 0)` is PostgreSQL's standard
   * UPSERT discriminator: true only for a newly inserted position, so
   * `bet_count` tracks unique bettors rather than placement events. The
   * `side_valid` guard keeps an impossible opposite-side event from changing
   * either table or poisoning the event-dedupe log.
   */
  const result = await db.query<BetPlacedWriteResult>(
    `WITH input AS (
       SELECT $1::BIGINT AS ledger_seq,
              $2::CHAR(64) AS tx_hash,
              $3::BIGINT AS event_index,
              $4::VARCHAR(50) AS event_type,
              $5::JSONB AS payload,
              $6::BIGINT AS market_id,
              $7::CHAR(56) AS bettor,
              $8::NUMERIC AS net_amount,
              $9::NUMERIC AS gross_amount,
              $10::BOOLEAN AS is_yes
     ), side_valid AS (
       SELECT i.*
       FROM input i
       WHERE NOT EXISTS (
         SELECT 1
         FROM bets b
         WHERE b.market_id = i.market_id
           AND b.bettor = i.bettor
           AND b.is_yes IS DISTINCT FROM i.is_yes
       )
     ), new_event AS (
       INSERT INTO events (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload)
       SELECT ledger_seq, tx_hash, event_index, event_type, market_id, bettor, payload
       FROM side_valid
       ON CONFLICT (tx_hash, event_index) DO NOTHING
       RETURNING 1
     ), upserted_bet AS (
       INSERT INTO bets (market_id, bettor, net_amount, gross_amount, is_yes)
       SELECT i.market_id, i.bettor, i.net_amount, i.gross_amount, i.is_yes
       FROM side_valid i
       CROSS JOIN new_event
       ON CONFLICT (market_id, bettor) DO UPDATE
       SET net_amount = bets.net_amount + EXCLUDED.net_amount,
           gross_amount = bets.gross_amount + EXCLUDED.gross_amount
       RETURNING is_yes, (xmax = 0) AS new_bettor
     ), market_update AS (
       UPDATE markets m
       SET total_yes = m.total_yes + CASE WHEN b.is_yes THEN i.net_amount ELSE 0 END,
           total_no = m.total_no + CASE WHEN b.is_yes THEN 0 ELSE i.net_amount END,
           bet_count = m.bet_count + CASE WHEN b.new_bettor THEN 1 ELSE 0 END,
           updated_at = NOW()
       FROM upserted_bet b
       CROSS JOIN input i
       WHERE m.id = i.market_id
       RETURNING m.id
     )
     SELECT EXISTS (SELECT 1 FROM side_valid) AS side_valid,
            EXISTS (SELECT 1 FROM new_event) AS event_inserted,
            EXISTS (SELECT 1 FROM market_update) AS applied`,
    [
      event.ledger,
      event.txHash,
      getEventIndex(event),
      "bet_placed",
      JSON.stringify(payload),
      payload.market_id,
      payload.bettor,
      payload.net_amount,
      payload.amount,
      payload.is_yes,
    ],
  );

  const write = result.rows[0];
  if (write?.side_valid === false) {
    throw new Error("bet_placed side conflicts with the existing position");
  }
  if (write?.event_inserted === true && write.applied === false) {
    throw new Error("bet_placed event could not update its market");
  }

  // Run on a duplicate too: the database writes are a no-op, while a retry can
  // repair a cache invalidation that failed after the original transaction.
  await invalidateOnBetPlaced(redis, payload.market_id);

  return payload;
}
