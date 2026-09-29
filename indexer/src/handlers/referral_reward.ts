import { referralRewardPayloadSchema, type ReferralRewardPayload } from "../schemas.js";
import { invalidateLeaderboardCache } from "../cache.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";
import { insertProcessedEvent } from "./idempotency.js";

export const REFERRAL_REWARD_TOPIC = ["referral", "reward"] as const;

export function decodeReferralRewardEvent(event: Pick<DecodedContractEvent, "topics" | "data">): ReferralRewardPayload {
  const [domain, action] = event.topics;
  if (domain !== REFERRAL_REWARD_TOPIC[0] || action !== REFERRAL_REWARD_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  return referralRewardPayloadSchema.parse(event.data);
}

export async function handleReferralRewardEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<ReferralRewardPayload> {
  const payload = decodeReferralRewardEvent(event);

  const inserted = await insertProcessedEvent(db, {
    event,
    eventType: "referral_reward",
    actor: payload.referrer,
    payload: JSON.stringify(payload),
  });
  if (!inserted) return payload;

  await db.query(
    `INSERT INTO leaderboard (address, display_name, points, won_bets, lost_bets, updated_at)
     VALUES ($1, NULL, $2, 0, 0, NOW())
     ON CONFLICT (address) DO UPDATE
     SET points = leaderboard.points + EXCLUDED.points,
         updated_at = NOW()`,
    [payload.referrer, payload.points],
  );

  await invalidateLeaderboardCache(redis);

  return payload;
}
