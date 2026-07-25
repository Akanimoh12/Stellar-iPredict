import { referralRegisteredPayloadSchema, type ReferralRegisteredPayload } from "../schemas.js";
import { invalidateLeaderboardCache } from "../cache.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

export const REFERRAL_REGISTERED_TOPIC = ["referral", "registered"] as const;

export function decodeReferralRegisteredEvent(
  event: Pick<DecodedContractEvent, "topics" | "data">,
): ReferralRegisteredPayload {
  const [domain, action] = event.topics;
  if (domain !== REFERRAL_REGISTERED_TOPIC[0] || action !== REFERRAL_REGISTERED_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  return referralRegisteredPayloadSchema.parse(event.data);
}

export async function handleReferralRegisteredEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<ReferralRegisteredPayload> {
  const payload = decodeReferralRegisteredEvent(event);

  // Registrant: record the canonical display name and credit the welcome bonus.
  // COALESCE keeps any existing name when the event omits one; ON CONFLICT keeps
  // the write a safe upsert (no duplicate rows on replay) — the same shape as
  // handleReferralRewardEvent and the leaderboard-rebuild reducer.
  await db.query(
    `INSERT INTO leaderboard (address, display_name, points, won_bets, lost_bets, updated_at)
     VALUES ($1, $2, $3, 0, 0, NOW())
     ON CONFLICT (address) DO UPDATE
     SET display_name = COALESCE(EXCLUDED.display_name, leaderboard.display_name),
         points = leaderboard.points + EXCLUDED.points,
         updated_at = NOW()`,
    [payload.user, payload.display_name, payload.welcome_points],
  );

  // Referrer (optional): credit the registration bonus. Mirrors
  // handleReferralRegistration in leaderboard-rebuild so incremental writes and
  // full replays converge on the same leaderboard snapshot.
  if (payload.referrer) {
    await db.query(
      `INSERT INTO leaderboard (address, display_name, points, won_bets, lost_bets, updated_at)
       VALUES ($1, NULL, $2, 0, 0, NOW())
       ON CONFLICT (address) DO UPDATE
       SET points = leaderboard.points + EXCLUDED.points,
           updated_at = NOW()`,
      [payload.referrer, payload.referrer_points],
    );
  }

  await invalidateLeaderboardCache(redis);

  return payload;
}
