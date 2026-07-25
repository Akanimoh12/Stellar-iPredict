import type { DecodedEvent, HandlerContext } from "./types.js";

export const REWARD_POINTS_TOPIC = "reward_points";

export interface RewardPointsPayload {
  user: string;
  points: number;
  is_winner?: boolean;
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

type RawRewardPointsPayload = {
  user?: unknown;
  address?: unknown;
  points?: unknown;
  is_winner?: unknown;
  winner?: unknown;
};

function normalizeAddress(value: unknown): string {
  if (typeof value === "string" && STELLAR_ADDRESS.test(value)) return value;
  throw new Error("reward_points user must be a valid Stellar public key");
}

function normalizePoints(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  throw new Error("reward_points points must be a non-negative integer");
}

function normalizeIsWinner(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "f", "no", "n", "0"].includes(normalized)) return false;
  }
  return undefined;
}

export function decodeRewardPoints(event: DecodedEvent): RewardPointsPayload {
  const raw = (event.data && typeof event.data === "object" && !Array.isArray(event.data))
    ? (event.data as RawRewardPointsPayload)
    : {};

  const user = normalizeAddress(raw.user ?? raw.address ?? event.topics[1] as unknown);
  const points = normalizePoints(raw.points ?? event.topics[2] as unknown);
  const isWinner = normalizeIsWinner(raw.is_winner ?? raw.winner);

  return {
    user,
    points,
    is_winner: isWinner,
  };
}

export async function handleRewardPoints(event: DecodedEvent, context: HandlerContext): Promise<void> {
  const payload = decodeRewardPoints(event);

  // Update leaderboard points and win/loss counts
  const wonBetsIncrement = payload.is_winner === true ? 1 : 0;
  const lostBetsIncrement = payload.is_winner === false ? 1 : 0;

  await context.db.query(
    `INSERT INTO leaderboard (address, display_name, points, won_bets, lost_bets, updated_at)
     VALUES ($1, NULL, $2, $3, $4, NOW())
     ON CONFLICT (address) DO UPDATE
     SET points = leaderboard.points + EXCLUDED.points,
         won_bets = leaderboard.won_bets + EXCLUDED.won_bets,
         lost_bets = leaderboard.lost_bets + EXCLUDED.lost_bets,
         updated_at = NOW()`,
    [payload.user, payload.points, wonBetsIncrement, lostBetsIncrement],
  );

  // Record the raw event for audit trail
  await context.db.query(
    `INSERT INTO events (ledger_seq, tx_hash, event_type, actor, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [event.ledger, event.txHash, REWARD_POINTS_TOPIC, payload.user, payload],
  );

  // Invalidate leaderboard cache
  await context.redis?.del("leaderboard:top20");
}
