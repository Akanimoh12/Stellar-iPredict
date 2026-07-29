import { handleMarketCancelledEvent } from "./handlers/market_cancelled.js";
import { handleReferralRewardEvent } from "./handlers/referral_reward.js";
import { handleReferralRegisteredEvent } from "./handlers/referral_registered.js";
import { metrics } from "./metrics.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "./types.js";

/**
 * Routes a decoded contract event to its handler and persists it.
 *
 * Increments the `events_processed_total` counter once per event that is
 * actually handled. Unrecognised events are skipped and not counted — they are
 * not indexed (see `docs/ORACLE_AND_BACKEND.md` for the metric catalogue).
 */
export async function writeEventToDb(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<void> {
  const [domain, action] = event.topics;

  if (domain === "mkt" && action === "cancelled") {
    await handleMarketCancelledEvent(event, db, redis);
  } else if (domain === "referral" && action === "reward") {
    await handleReferralRewardEvent(event, db, redis);
  } else if (domain === "referral" && action === "registered") {
    await handleReferralRegisteredEvent(event, db, redis);
  } else {
    // Unrecognised event — not indexed, so it does not count as processed.
    return;
  }

  metrics.eventsProcessed.inc();
}
