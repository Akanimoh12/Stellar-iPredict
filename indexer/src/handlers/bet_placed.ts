import { invalidateOnBetPlaced } from "../cache.js";
import { parseEventPayload, type BetPlacedPayload } from "../schemas.js";
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

  return parseEventPayload("bet_placed", payload);
}

type BetPlacedWriteResult = {
  side_valid: boolean;
  markets_present: boolean;
  event_inserted: boolean | number | string;
  applied: boolean | number | string;
};

type PreparedBetPlacedEvent = {
  event: DecodedContractEvent;
  payload: BetPlacedPayload;
};

function prepareBatch(events: readonly DecodedContractEvent[]): PreparedBetPlacedEvent[] {
  if (events.length === 0) return [];

  const ledger = events[0].ledger;
  const eventKeys = new Map<string, string>();
  return events.map((event) => {
    if (event.ledger !== ledger) {
      throw new Error("bet_placed batches must contain events from exactly one ledger");
    }

    const payload = decodeBetPlacedEvent(event);
    const key = `${event.txHash}:${getEventIndex(event).toString()}`;
    const canonicalPayload = JSON.stringify(payload);
    const previousPayload = eventKeys.get(key);
    if (previousPayload !== undefined && previousPayload !== canonicalPayload) {
      throw new Error(`duplicate bet_placed event ${key} has conflicting payloads`);
    }
    eventKeys.set(key, canonicalPayload);
    return { event, payload };
  });
}

/**
 * Persist an ordered group of compatible bet placements from one ledger.
 *
 * The database receives the whole group as one JSONB parameter and performs
 * audit insertion, position aggregation, and market aggregation in one SQL
 * statement. The statement gates every write on batch validation and contains
 * an invariant guard: any side conflict, missing market, or partial upsert
 * raises inside PostgreSQL, rolling the complete statement back.
 */
export async function handleBetPlacedEvents(
  events: readonly DecodedContractEvent[],
  db: DbClient,
  redis: RedisClient,
): Promise<BetPlacedPayload[]> {
  const prepared = prepareBatch(events);
  if (prepared.length === 0) return [];

  const input = prepared.map(({ event, payload }, ordinal) => ({
    ordinal,
    ledger_seq: event.ledger,
    tx_hash: event.txHash,
    event_index: getEventIndex(event).toString(),
    payload,
    market_id: payload.market_id,
    bettor: payload.bettor,
    net_amount: payload.net_amount,
    gross_amount: payload.amount,
    is_yes: payload.is_yes,
  }));

  /**
   * The audit writes, position upserts, and market aggregate updates remain one
   * statement. A separate `events` insert would make a crash after that insert
   * unrecoverable: a replay would dedupe events while derived state was still
   * missing. `new_event` therefore gates every downstream CTE.
   *
   * DISTINCT ON keeps the first occurrence of a duplicate delivery in original
   * order. Same-side placements are additive, so grouping them is equivalent
   * to applying them sequentially while reducing database round trips.
   */
  const result = await db.query<BetPlacedWriteResult>(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($1::JSONB) AS event(
         ordinal INTEGER,
         ledger_seq BIGINT,
         tx_hash TEXT,
         event_index BIGINT,
         payload JSONB,
         market_id BIGINT,
         bettor TEXT,
         net_amount NUMERIC,
         gross_amount NUMERIC,
         is_yes BOOLEAN
       )
     ), deduped_input AS (
       SELECT DISTINCT ON (tx_hash, event_index) *
       FROM input
       ORDER BY tx_hash, event_index, ordinal
     ), validation AS (
       SELECT
         NOT EXISTS (
           SELECT 1
           FROM deduped_input a
           JOIN deduped_input b
             ON b.market_id = a.market_id
            AND b.bettor = a.bettor
            AND b.is_yes IS DISTINCT FROM a.is_yes
         ) AND NOT EXISTS (
           SELECT 1
           FROM deduped_input i
           JOIN bets b
             ON b.market_id = i.market_id
            AND b.bettor = i.bettor
            AND b.is_yes IS DISTINCT FROM i.is_yes
         ) AS side_valid,
         NOT EXISTS (
           SELECT 1
           FROM deduped_input i
           LEFT JOIN markets m ON m.id = i.market_id
           WHERE m.id IS NULL
         ) AS markets_present
     ), new_event AS (
       INSERT INTO events (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload)
       SELECT i.ledger_seq, i.tx_hash, i.event_index, 'bet_placed', i.market_id, i.bettor, i.payload
       FROM deduped_input i
       CROSS JOIN validation v
       WHERE v.side_valid AND v.markets_present
       ORDER BY i.ordinal
       ON CONFLICT (tx_hash, event_index) DO NOTHING
       RETURNING tx_hash, event_index
     ), applicable AS (
       SELECT i.*
       FROM deduped_input i
       JOIN new_event e
         ON e.tx_hash = i.tx_hash
        AND e.event_index = i.event_index
     ), bet_deltas AS (
       SELECT market_id, bettor, is_yes,
              SUM(net_amount) AS net_amount,
              SUM(gross_amount) AS gross_amount
       FROM applicable
       GROUP BY market_id, bettor, is_yes
     ), upserted_bet AS (
       INSERT INTO bets (market_id, bettor, net_amount, gross_amount, is_yes)
       SELECT market_id, bettor, net_amount, gross_amount, is_yes
       FROM bet_deltas
       ON CONFLICT (market_id, bettor) DO UPDATE
       SET net_amount = bets.net_amount + EXCLUDED.net_amount,
           gross_amount = bets.gross_amount + EXCLUDED.gross_amount
       WHERE bets.is_yes IS NOT DISTINCT FROM EXCLUDED.is_yes
       RETURNING market_id, (xmax = 0) AS new_bettor
     ), market_deltas AS (
       SELECT market_id,
              SUM(net_amount) FILTER (WHERE is_yes) AS yes_amount,
              SUM(net_amount) FILTER (WHERE NOT is_yes) AS no_amount
       FROM applicable
       GROUP BY market_id
     ), new_bettor_counts AS (
       SELECT market_id, COUNT(*) FILTER (WHERE new_bettor) AS count
       FROM upserted_bet
       GROUP BY market_id
     ), market_update AS (
       UPDATE markets m
       SET total_yes = m.total_yes + COALESCE(d.yes_amount, 0),
           total_no = m.total_no + COALESCE(d.no_amount, 0),
           bet_count = m.bet_count + COALESCE(c.count, 0),
           updated_at = NOW()
       FROM market_deltas d
       LEFT JOIN new_bettor_counts c ON c.market_id = d.market_id
       WHERE m.id = d.market_id
       RETURNING m.id
     ), invariant AS (
       SELECT v.side_valid,
              v.markets_present,
              (SELECT COUNT(*) FROM new_event) AS event_inserted,
              (SELECT COUNT(*) FROM applicable) AS applied,
              (SELECT COUNT(*) FROM bet_deltas) AS expected_positions,
              (SELECT COUNT(*) FROM upserted_bet) AS actual_positions,
              (SELECT COUNT(*) FROM market_deltas) AS expected_markets,
              (SELECT COUNT(*) FROM market_update) AS actual_markets
       FROM validation v
     )
     SELECT side_valid,
            markets_present,
            event_inserted,
            applied,
            1 / CASE
              WHEN side_valid
               AND markets_present
               AND expected_positions = actual_positions
               AND expected_markets = actual_markets
              THEN 1 ELSE 0
            END AS invariant_guard
     FROM invariant`,
    [JSON.stringify(input)],
  );

  const write = result.rows[0];
  if (write?.side_valid === false) {
    throw new Error("bet_placed batch contains a side conflict");
  }
  if (write?.markets_present === false) {
    throw new Error("bet_placed batch references a missing market");
  }

  // Run on duplicates too: database writes no-op, while a retry can repair a
  // cache invalidation that failed after the original database statement.
  for (const marketId of new Set(prepared.map(({ payload }) => payload.market_id))) {
    await invalidateOnBetPlaced(redis, marketId);
  }

  return prepared.map(({ payload }) => payload);
}

export async function handleBetPlacedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<BetPlacedPayload> {
  const [payload] = await handleBetPlacedEvents([event], db, redis);
  return payload;
}
