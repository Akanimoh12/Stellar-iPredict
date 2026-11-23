import type { DecodedEvent, HandlerContext } from "./types.js";
import { insertProcessedEvent } from "./idempotency.js";

/**
 * Optimistic-oracle `submit_outcome` event.
 *
 * Emitted by the prediction_market contract when a submitter posts a bonded
 * outcome for a market (Phase 2). The handler records the raw event for
 * idempotency and upserts a row into `oracle_submissions`.
 */
export const ORACLE_SUBMISSION_TOPIC = "submit_outcome";

export interface OracleSubmissionPayload {
  market_id: number;
  submitter: string;
  /** Proposed outcome, normalised to the same "yes"/"no" label the aggregator persists. */
  outcome: string;
  /** Submitter bond in stroops, as a decimal string (NUMERIC column). */
  bond_amount: string;
}

const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/;

type RawPayload = {
  market_id?: unknown;
  submitter?: unknown;
  submitter_address?: unknown;
  outcome?: unknown;
  bond?: unknown;
  bond_amount?: unknown;
};

function normalizeMarketId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error("submit_outcome market_id must be a non-negative integer");
}

function normalizeAddress(value: unknown): string {
  if (typeof value === "string" && STELLAR_ADDRESS.test(value)) return value;
  throw new Error("submit_outcome submitter must be a valid Stellar address");
}

function normalizeOutcome(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (value === 1) return "yes";
    if (value === 0) return "no";
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1"].includes(normalized)) return "yes";
    if (["false", "f", "no", "n", "0"].includes(normalized)) return "no";
  }
  throw new Error("submit_outcome outcome must be a boolean-like value");
}

function normalizeBond(value: unknown): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new Error("submit_outcome bond_amount must be a non-negative integer");
}

export function decodeOracleSubmission(event: DecodedEvent): OracleSubmissionPayload {
  const raw = (event.data && typeof event.data === "object" && !Array.isArray(event.data))
    ? (event.data as RawPayload)
    : {};

  return {
    market_id: normalizeMarketId(raw.market_id ?? (event.topics[1] as unknown)),
    submitter: normalizeAddress(raw.submitter ?? raw.submitter_address ?? (event.topics[2] as unknown)),
    outcome: normalizeOutcome(raw.outcome),
    bond_amount: normalizeBond(raw.bond ?? raw.bond_amount),
  };
}

export async function handleOracleSubmission(event: DecodedEvent, context: HandlerContext): Promise<void> {
  const payload = decodeOracleSubmission(event);

  const inserted = await insertProcessedEvent(context.db, {
    event,
    eventType: ORACLE_SUBMISSION_TOPIC,
    marketId: payload.market_id,
    actor: payload.submitter,
    payload,
  });
  // Idempotency guard: a replayed event is a no-op, so no double-submit row.
  if (!inserted) return;

  // `oracle_submissions` is UNIQUE on market_id (migration 0008). The
  // ON CONFLICT DO NOTHING keeps the first submission and prevents any
  // second submission from overwriting a market already being resolved.
  await context.db.query(
    `INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount, status)
     VALUES ($1, $2, $3, $4, 'submitted')
     ON CONFLICT (market_id) DO NOTHING`,
    [payload.market_id, payload.submitter, payload.outcome, payload.bond_amount],
  );
}
