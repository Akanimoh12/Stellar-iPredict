import { invalidateOnMarketResolved } from "../cache.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";
import { insertProcessedEvent } from "./idempotency.js";
import {
  asRecord,
  normalizeAmount,
  normalizeBool,
  normalizeMarketId,
  normalizeOptionalAddress,
  normalizeAddress,
  normalizeOutcome,
  normalizeTimestamp,
} from "./oracle_common.js";

// Topic per docs/ORACLE_AND_BACKEND.md → "Oracle Event Topics" and
// contracts/prediction_market/src/lib.rs `OracleFinalizedEvent`. Emitted by
// both `finalize_outcome` (unchallenged, challenged=false) and
// `resolve_challenge` (council ruling, challenged=true).
export const ORACLE_FINALIZED_TOPIC = ["oracle", "finalized"] as const;

export interface OracleFinalizedPayload {
  market_id: number;
  outcome: string;
  challenged: boolean;
  submitter: string;
  challenger: string | null;
  submitter_payout: string;
  challenger_payout: string;
  council_fee: string;
  protocol_credit: string;
  finalized_at: Date;
}

export function decodeOracleFinalizedEvent(
  event: Pick<DecodedContractEvent, "topics" | "data">,
): OracleFinalizedPayload {
  const [domain, action] = event.topics;
  if (domain !== ORACLE_FINALIZED_TOPIC[0] || action !== ORACLE_FINALIZED_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  const raw = asRecord(event.data);
  return {
    market_id: normalizeMarketId(raw.market_id),
    outcome: normalizeOutcome(raw.outcome),
    challenged: normalizeBool(raw.challenged, "challenged"),
    submitter: normalizeAddress(raw.submitter, "submitter"),
    challenger: normalizeOptionalAddress(raw.challenger, "challenger"),
    submitter_payout: normalizeAmount(raw.submitter_payout, "submitter_payout"),
    challenger_payout: normalizeAmount(raw.challenger_payout, "challenger_payout"),
    council_fee: normalizeAmount(raw.council_fee, "council_fee"),
    protocol_credit: normalizeAmount(raw.protocol_credit, "protocol_credit"),
    finalized_at: normalizeTimestamp(raw.finalized_at, "finalized_at"),
  };
}

/**
 * A `finalized` event settles bonds on-chain regardless of market state (see
 * docs/ORACLE_AND_BACKEND.md: cancelled/force-resolved markets still run the
 * finalizer so bonds aren't stranded, but the resolution step is skipped).
 * The `markets` UPDATE is therefore guarded on `resolved = FALSE AND
 * cancelled = FALSE` so this handler never overwrites an outcome a market
 * already has — combined with the `events` idempotency guard, a replayed or
 * out-of-band finalize can't double-apply a resolution.
 */
export async function handleOracleFinalizedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  redis: RedisClient,
): Promise<OracleFinalizedPayload> {
  const payload = decodeOracleFinalizedEvent(event);

  const inserted = await insertProcessedEvent(db, {
    event,
    eventType: "oracle_finalized",
    marketId: payload.market_id,
    actor: payload.submitter,
    payload: JSON.stringify(payload),
  });
  if (!inserted) return payload;

  const marketUpdate = await db.query(
    `UPDATE markets
     SET resolved = TRUE,
         outcome = $2,
         cancelled = FALSE,
         updated_at = NOW()
     WHERE id = $1 AND resolved = FALSE AND cancelled = FALSE`,
    [payload.market_id, payload.outcome],
  );

  // Guarded so a submission already finalized/rejected can't be re-finalized.
  await db.query(
    `UPDATE oracle_submissions
     SET status = 'finalized',
         decision = $2,
         tx_hash = $3,
         finalized_at = $4
     WHERE market_id = $1 AND status IN ('submitted', 'challenged')`,
    [payload.market_id, payload.outcome, event.txHash, payload.finalized_at],
  );

  if (marketUpdate.rowCount > 0) {
    await invalidateOnMarketResolved(redis, payload.market_id);
  }

  return payload;
}
