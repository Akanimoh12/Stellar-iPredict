import {handleMarketCancelledEvent } from "./handlers/market_cancelled.js";
import { handleBetPlacedEvent, isBetPlacedTopic } from "./handlers/bet_placed.js";
import { handleOracleChallengedEvent, handleOracleEscalatedEvent } from "./handlers/oracle_challenge.js";
import { handleOracleFinalizedEvent } from "./handlers/oracle_finalized.js";
import { handleReferralRewardEvent } from "./handlers/referral_reward.js";
import { handleReferralRegisteredEvent } from "./handlers/referral_registered.js";
import { metrics } from "./metrics.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "./types.js";

/**
 * Routes a decoded contract event to its handler and persists it.
 *
 * Increments the `events_processed_total` counter once per event that is
 * actually handled. Unrecognised events are persisted to the dead-letter table
 * and are not counted — they are not indexed (see `docs/ORACLE_AND_BACKEND.md`
 * for the metric catalogue).
 */
export async function writeEventToDb(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<void> {
  const [domain, action] = event.topics;

  if (domain === "mkt" && action === "cancelled") {
    await handleMarketCancelledEvent(event, db, redis);
  } else if (isBetPlacedTopic(event.topics)) {
    await handleBetPlacedEvent(event, db, redis);
  } else if (domain === "referral" && action === "reward") {
    await handleReferralRewardEvent(event, db, redis);
  } else if (domain === "referral" && action === "registered") {
    await handleReferralRegisteredEvent(event, db, redis);
  } else if (domain === "oracle" && action === "challenged") {
    await handleOracleChallengedEvent(event, db, redis);
  } else if (domain === "oracle" && action === "escalated") {
    await handleOracleEscalatedEvent(event, db, redis);
  } else if (domain === "oracle" && action === "finalized") {
    await handleOracleFinalizedEvent(event, db, redis);
  } else {
    // Unrecognised event — persist to dead-letter table for inspection.
    try {
      await db.query(
        `IMSERT INTO dead_letter_events (event_type, payload, error) VALUES ($1, $2, $3)`,
        [`${domain}:${action}`, JSON.stringify(event), "unrecognized event type"]
      );
    } catch (error) {
      console.error("Failed to persist dead-letter event", error);
    }
    return;
  }

  metrics.eventsProcessed.inc();
}
