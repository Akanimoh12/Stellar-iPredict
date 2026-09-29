import type { DecodedEvent, HandlerContext } from "./types.js";
import { insertProcessedEvent } from "./idempotency.js";

export const FEES_WITHDRAWN_TOPIC = "fees_withdrawn";

export interface FeeWithdrawnPayload {
  admin: string;
  amount: string;
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

type RawFeeWithdrawnPayload = {
  admin?: unknown;
  amount?: unknown;
};

function normalizeAmount(amount: unknown): string {
  if (typeof amount === "bigint") return amount.toString();
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) return String(amount);
  if (typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount)) return amount;
  throw new Error("fee_withdrawn amount must be a non-negative numeric value");
}

export function decodeFeeWithdrawn(event: DecodedEvent): FeeWithdrawnPayload {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
    throw new Error("fee_withdrawn payload must be an object");
  }

  const payload = event.data as RawFeeWithdrawnPayload;

  if (typeof payload.admin !== "string" || !STELLAR_ADDRESS.test(payload.admin)) {
    throw new Error("fee_withdrawn admin must be a valid Stellar public key");
  }

  if (payload.amount === undefined || payload.amount === null) {
    throw new Error("fee_withdrawn amount is required");
  }

  return {
    admin: payload.admin,
    amount: normalizeAmount(payload.amount),
  };
}

export async function handleFeeWithdrawn(event: DecodedEvent, context: HandlerContext): Promise<void> {
  const payload = decodeFeeWithdrawn(event);

  const inserted = await insertProcessedEvent(context.db, {
    event,
    eventType: FEES_WITHDRAWN_TOPIC,
    actor: payload.admin,
    payload,
  });
  if (!inserted) return;

  await context.redis?.del("stats:global");
}
