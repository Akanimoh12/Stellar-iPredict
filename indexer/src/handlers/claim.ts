import type { DecodedEvent, HandlerContext } from "./types.js";

export const REWARD_CLAIMED_TOPIC = "reward_claimed";

export interface ClaimPayload {
  market_id: number;
  user: string;
  payout_xlm?: number;
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

type RawClaimPayload = {
  market_id?: unknown;
  user?: unknown;
  bettor?: unknown;
  payout_xlm?: unknown;
  payout?: unknown;
};

function normalizeMarketId(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  throw new Error("claim market_id must be a non-negative integer");
}

function normalizeAddress(value: unknown): string {
  if (typeof value === "string" && STELLAR_ADDRESS.test(value)) return value;
  throw new Error("claim user must be a valid Stellar public key");
}

function normalizePayout(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export function decodeClaim(event: DecodedEvent): ClaimPayload {
  const raw = (event.data && typeof event.data === "object" && !Array.isArray(event.data))
    ? (event.data as RawClaimPayload)
    : {};

  const marketId = normalizeMarketId(raw.market_id ?? event.topics[1] as unknown);
  const user = normalizeAddress(raw.user ?? raw.bettor ?? event.topics[2] as unknown);

  return {
    market_id: marketId,
    user,
    payout_xlm: normalizePayout(raw.payout_xlm ?? raw.payout),
  };
}

export async function handleClaim(event: DecodedEvent, context: HandlerContext): Promise<void> {
  const payload = decodeClaim(event);

  await context.db.query(
    `UPDATE bets SET claimed = true WHERE market_id = $1 AND bettor = $2`,
    [payload.market_id, payload.user],
  );

  await context.db.query(
    `INSERT INTO events (ledger_seq, tx_hash, event_type, market_id, actor, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [event.ledger, event.txHash, REWARD_CLAIMED_TOPIC, payload.market_id, payload.user, payload],
  );

  await context.redis?.del(`bets:${payload.market_id}`, "leaderboard:top20");
}
