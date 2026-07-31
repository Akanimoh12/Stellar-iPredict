import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";
import { insertProcessedEvent } from "./idempotency.js";
import {
  asRecord,
  normalizeAddress,
  normalizeAmount,
  normalizeMarketId,
  normalizeOutcome,
  normalizeTimestamp,
} from "./oracle_common.js";

// Topics per docs/ORACLE_AND_BACKEND.md → "Oracle Event Topics" and
// contracts/prediction_market/src/lib.rs `OracleChallengedEvent` /
// `OracleEscalatedEvent`. `challenge()` emits both, in this order, in one
// transaction — the `Challenged` state is never observable on-chain alone.
export const ORACLE_CHALLENGED_TOPIC = ["oracle", "challenged"] as const;
export const ORACLE_ESCALATED_TOPIC = ["oracle", "escalated"] as const;

export interface OracleChallengedPayload {
  market_id: number;
  challenger: string;
  outcome: string;
  bond: string;
  submitter: string;
  submitter_bond: string;
  challenged_at: Date;
}

export interface OracleEscalatedPayload {
  market_id: number;
  submitter: string;
  challenger: string;
  outcome: string;
  total_bond: string;
  escalated_at: Date;
  council_deadline: Date;
}

export function decodeOracleChallengedEvent(
  event: Pick<DecodedContractEvent, "topics" | "data">,
): OracleChallengedPayload {
  const [domain, action] = event.topics;
  if (domain !== ORACLE_CHALLENGED_TOPIC[0] || action !== ORACLE_CHALLENGED_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  const raw = asRecord(event.data);
  return {
    market_id: normalizeMarketId(raw.market_id),
    challenger: normalizeAddress(raw.challenger, "challenger"),
    outcome: normalizeOutcome(raw.outcome),
    bond: normalizeAmount(raw.bond, "bond"),
    submitter: normalizeAddress(raw.submitter, "submitter"),
    submitter_bond: normalizeAmount(raw.submitter_bond, "submitter_bond"),
    challenged_at: normalizeTimestamp(raw.challenged_at, "challenged_at"),
  };
}

export function decodeOracleEscalatedEvent(
  event: Pick<DecodedContractEvent, "topics" | "data">,
): OracleEscalatedPayload {
  const [domain, action] = event.topics;
  if (domain !== ORACLE_ESCALATED_TOPIC[0] || action !== ORACLE_ESCALATED_TOPIC[1]) {
    throw new Error(`Unexpected event topic: ${String(domain)}:${String(action)}`);
  }

  const raw = asRecord(event.data);
  return {
    market_id: normalizeMarketId(raw.market_id),
    submitter: normalizeAddress(raw.submitter, "submitter"),
    challenger: normalizeAddress(raw.challenger, "challenger"),
    outcome: normalizeOutcome(raw.outcome),
    total_bond: normalizeAmount(raw.total_bond, "total_bond"),
    escalated_at: normalizeTimestamp(raw.escalated_at, "escalated_at"),
    council_deadline: normalizeTimestamp(raw.council_deadline, "council_deadline"),
  };
}

/**
 * `oracle_disputes` is UNIQUE on market_id (migration 0009), so a market can
 * only ever be challenged once — a replayed or re-delivered `challenged`
 * event ON CONFLICT DO NOTHINGs instead of creating a second dispute row.
 * Neither `challenged` nor `escalated` move funds (bonds only settle on
 * `finalized`), so there is no payout path here to double.
 */
export async function handleOracleChallengedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  _redis: RedisClient,
): Promise<OracleChallengedPayload> {
  const payload = decodeOracleChallengedEvent(event);

  const inserted = await insertProcessedEvent(db, {
    event,
    eventType: "oracle_challenged",
    marketId: payload.market_id,
    actor: payload.challenger,
    payload: JSON.stringify(payload),
  });
  if (!inserted) return payload;

  await db.query(
    `INSERT INTO oracle_disputes
       (market_id, submitter, challenger, outcome, submitter_bond, challenger_bond, status, challenged_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'challenged', $7)
     ON CONFLICT (market_id) DO NOTHING`,
    [
      payload.market_id,
      payload.submitter,
      payload.challenger,
      payload.outcome,
      payload.submitter_bond,
      payload.bond,
      payload.challenged_at,
    ],
  );

  // Guarded by status = 'submitted' so a market already finalized (or
  // somehow re-challenged) can't be regressed back to 'challenged'.
  await db.query(
    `UPDATE oracle_submissions SET status = 'challenged' WHERE market_id = $1 AND status = 'submitted'`,
    [payload.market_id],
  );

  return payload;
}

/**
 * Only advances a dispute already in `challenged` — a replayed or
 * out-of-order `escalated` event can't move a market past a later
 * finalization, and idempotency (via `events`) keeps it from re-running.
 */
export async function handleOracleEscalatedEvent(
  event: DecodedContractEvent,
  db: DbClient,
  _redis: RedisClient,
): Promise<OracleEscalatedPayload> {
  const payload = decodeOracleEscalatedEvent(event);

  const inserted = await insertProcessedEvent(db, {
    event,
    eventType: "oracle_escalated",
    marketId: payload.market_id,
    actor: payload.challenger,
    payload: JSON.stringify(payload),
  });
  if (!inserted) return payload;

  await db.query(
    `UPDATE oracle_disputes
     SET status = 'escalated',
         total_bond = $2,
         escalated_at = $3,
         council_deadline = $4
     WHERE market_id = $1 AND status = 'challenged'`,
    [payload.market_id, payload.total_bond, payload.escalated_at, payload.council_deadline],
  );

  return payload;
}
