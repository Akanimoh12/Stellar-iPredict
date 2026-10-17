import { EVENT_TOPICS } from "@ipredict/shared";
import { handleMarketCreatedEvent, decodeMarketCreatedEvent } from "./handlers/market_created.js";
import { handleMarketResolvedEvent, decodeMarketResolvedEvent } from "./handlers/market_resolved.js";
import { handleMarketCancelledEvent, decodeMarketCancelledEvent } from "./handlers/market_cancelled.js";
import { handleBetPlacedEvent, isBetPlacedTopic, decodeBetPlacedEvent } from "./handlers/bet_placed.js";
import { handleReferralRewardEvent, decodeReferralRewardEvent } from "./handlers/referral_reward.js";
import { handleReferralRegisteredEvent, decodeReferralRegisteredEvent } from "./handlers/referral_registered.js";
import {
  handleOracleChallengedEvent,
  handleOracleEscalatedEvent,
  decodeOracleChallengedEvent,
  decodeOracleEscalatedEvent,
} from "./handlers/oracle_challenge.js";
import {
  handleOracleFinalizedEvent,
  decodeOracleFinalizedEvent,
} from "./handlers/oracle_finalized.js";
import { metrics } from "./metrics.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "./types.js";

/**
 * Schema-validated event router (issue #499).
 *
 * Every decoded event crosses this boundary exactly once. Before a handler
 * runs, its payload is applied to the schema the handler expects
 * (`decode*Event` re-parses through `schemas.ts` / the oracle normalizers), so
 * a contract change that silently alters an event's shape is caught here
 * instead of reaching handler logic.
 *
 * A payload that fails validation is written to `dead_letter_events` with a
 * reason naming the failing field, and is *not* rethrown: a malformed event
 * must never crash the poll loop. Handler/database errors after a successful
 * validation ARE rethrown, preserving the at-least-once semantics that
 * `Indexer.indexOnce` and `reprocessDeadLetterEvent` rely on.
 */

interface EventRoute {
  /** Canonical event type name, used for metrics and dead-letter reasons. */
  name: string;
  /** Topic matcher — decides which route owns this event. */
  matches: (topics: readonly unknown[]) => boolean;
  /**
   * Applies the route's schema at the boundary. Throws (ZodValidationError or
   * a decode error naming the failing field) when the payload is malformed.
   */
  validate: (event: DecodedContractEvent) => unknown;
  /** The handler — runs only after validation succeeds. */
  handle: (event: DecodedContractEvent, db: DbClient, redis: RedisClient) => Promise<unknown>;
}

const ROUTES: EventRoute[] = [
  {
    name: "market_created",
    matches: (t) => t[0] === EVENT_TOPICS.market.created[0] && t[1] === EVENT_TOPICS.market.created[1],
    validate: (e) => decodeMarketCreatedEvent(e),
    handle: (e, db, redis) => handleMarketCreatedEvent(e, db, redis),
  },
  {
    // Checked before the other market/bet pairs: `bet_placed` has three
    // historical topic shapes (["bet_placed"], ["bet","placed"], ["bet"]).
    name: "bet_placed",
    matches: (t) => isBetPlacedTopic(t),
    validate: (e) => decodeBetPlacedEvent(e),
    handle: (e, db, redis) => handleBetPlacedEvent(e, db, redis),
  },
  {
    name: "market_resolved",
    matches: (t) =>
      t[0] === "market_resolved" ||
      (t[0] === EVENT_TOPICS.market.resolved[0] && t[1] === EVENT_TOPICS.market.resolved[1]),
    validate: (e) => decodeMarketResolvedEvent(e),
    handle: (e, db, redis) => handleMarketResolvedEvent(e, db, redis),
  },
  {
    name: "market_cancelled",
    matches: (t) => t[0] === EVENT_TOPICS.market.cancelled[0] && t[1] === EVENT_TOPICS.market.cancelled[1],
    validate: (e) => decodeMarketCancelledEvent(e),
    handle: (e, db, redis) => handleMarketCancelledEvent(e, db, redis),
  },
  {
    name: "referral_registered",
    matches: (t) => t[0] === EVENT_TOPICS.referral.registered[0] && t[1] === EVENT_TOPICS.referral.registered[1],
    validate: (e) => decodeReferralRegisteredEvent(e),
    handle: (e, db, redis) => handleReferralRegisteredEvent(e, db, redis),
  },
  {
    name: "referral_reward",
    matches: (t) => t[0] === EVENT_TOPICS.referral.reward[0] && t[1] === EVENT_TOPICS.referral.reward[1],
    validate: (e) => decodeReferralRewardEvent(e),
    handle: (e, db, redis) => handleReferralRewardEvent(e, db, redis),
  },
  {
    name: "oracle_challenged",
    matches: (t) => t[0] === EVENT_TOPICS.oracle.challenged[0] && t[1] === EVENT_TOPICS.oracle.challenged[1],
    validate: (e) => decodeOracleChallengedEvent(e),
    handle: (e, db, redis) => handleOracleChallengedEvent(e, db, redis),
  },
  {
    name: "oracle_escalated",
    matches: (t) => t[0] === EVENT_TOPICS.oracle.escalated[0] && t[1] === EVENT_TOPICS.oracle.escalated[1],
    validate: (e) => decodeOracleEscalatedEvent(e),
    handle: (e, db, redis) => handleOracleEscalatedEvent(e, db, redis),
  },
  {
    name: "oracle_finalized",
    matches: (t) => t[0] === EVENT_TOPICS.oracle.finalized[0] && t[1] === EVENT_TOPICS.oracle.finalized[1],
    validate: (e) => decodeOracleFinalizedEvent(e),
    handle: (e, db, redis) => handleOracleFinalizedEvent(e, db, redis),
  },
];

function findRoute(topics: readonly unknown[]): EventRoute | undefined {
  return ROUTES.find((route) => route.matches(topics));
}

/**
 * Persist an event to the dead-letter queue.
 *
 * Columns match migration 0010 (`ledger_seq, tx_hash, raw_event, error_message`)
 * so the row stays reprocessable by `reprocessDeadLetterEvent`. The raw decoded
 * event is stored whole, and the reason names the route and the failing field.
 * A failure to persist is logged and swallowed — the dead-letter path itself
 * must never be the thing that crashes the poll loop.
 */
async function deadLetterEvent(
  db: DbClient,
  event: DecodedContractEvent,
  reason: string,
): Promise<void> {
  metrics.eventsDeadLettered.inc();
  try {
    await db.query(
      `INSERT INTO dead_letter_events (ledger_seq, tx_hash, raw_event, error_message, created_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())`,
      // The decoded payload may contain BigInts (i128 stroop amounts, unix
      // timestamps); JSON.stringify throws on them, which must never stop the
      // dead-letter write. Serialize BigInts as their decimal string form —
      // the same representation the schemas parse back on replay.
      [event.ledger, event.txHash, JSON.stringify(event, (_, v) => (typeof v === "bigint" ? v.toString() : v)), reason],
    );
  } catch (error) {
    console.error("Failed to persist dead-letter event", error);
  }
}

/**
 * Routes a decoded contract event to its handler and persists it.
 *
 * Flow: topic match → schema validation (malformed ⇒ dead-letter, swallowed) →
 * handler dispatch (errors propagate to the caller's at-least-once recovery).
 *
 * Increments the `events_processed_total` counter once per event that is
 * actually handled; validation failures are counted under
 * `events_dead_lettered_total` instead (see `docs/ORACLE_AND_BACKEND.md` for
 * the metric catalogue).
 */
export async function writeEventToDb(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<void> {
  const [domain, action] = event.topics;
  const route = findRoute(event.topics);

  if (!route) {
    await deadLetterEvent(db, event, `unrecognized event type: ${String(domain)}:${String(action)}`);
    return;
  }

  // Schema boundary: a malformed payload never reaches handler logic.
  try {
    route.validate(event);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await deadLetterEvent(db, event, `${route.name} payload failed validation: ${detail}`);
    return;
  }

  await route.handle(event, db, redis);

  metrics.eventsProcessed.inc();
  metrics.eventsByType.inc(route.name);
}
