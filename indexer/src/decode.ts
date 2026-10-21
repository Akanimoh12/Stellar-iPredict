import { scValToNative, xdr } from "@stellar/stellar-sdk";

export interface DecodedEvent {
  type: string;
  subtype: string | undefined;
  data: unknown;
}

export interface DecodedTopics {
  type: string;
  subtype: string | undefined;
  args: unknown[];
}

let deadLetterHandler: (error: Error, topics: xdr.ScVal[], value: xdr.ScVal) => void = (
  error,
  topics,
  value
) => {
  console.error("Dead-letter: failed to decode event", { error: error.message, topics, value });
};

export function setDeadLetterHandler(
  handler: (error: Error, topics: xdr.ScVal[], value: xdr.ScVal) => void
) {
  deadLetterHandler = handler;
}

export function decodeTopics(topics: xdr.ScVal[]): DecodedTopics {
  const decoded = topics.map((t) => scValToNative(t));
  return {
    type: String(decoded[0] ?? ""),
    subtype: decoded.length > 1 ? String(decoded[1]) : undefined,
    args: decoded.slice(2),
  };
}

export function decodeValue(value: xdr.ScVal): unknown {
  return scValToNative(value);
}

/**
 * Soroban uses signed i128 token amounts, but transfers, stakes, fees and
 * payouts emitted by these contracts must be within [0, i128::MAX].
 * Validate BEFORE passing the native payload to DB handlers. Non-monetary
 * signed fields remain allowed (decodeValue is intentionally generic).
 */
export const MAX_EVENT_AMOUNT = (1n << 127n) - 1n;
const AMOUNT_FIELD = /(?:amount|fee|bond|payout|stake|credit|total_yes|total_no|total_pool)$/i;

function validateAmount(value: unknown, field: string): void {
  if (
    (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    (typeof value === "string" && !/^[+-]?\\d+$/.test(value))
  ) {
    throw new Error(`Invalid event amount at ${field}: expected an integer`);
  }
  const amount = BigInt(value);
  if (amount < 0n || amount > MAX_EVENT_AMOUNT) {
    throw new Error(`Invalid event amount at ${field}: outside the non-negative i128 range`);
  }
}

export function assertValidEventAmounts(type: string, subtype: string | undefined, data: unknown): void {
  const walk = (value: unknown, path: string): void => {
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        const field = String(key);
        if (AMOUNT_FIELD.test(field)) validateAmount(entry, `${path}.${field}`);
        else walk(entry, `${path}.${field}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [field, entry] of Object.entries(value)) {
        if (AMOUNT_FIELD.test(field)) validateAmount(entry, `${path}.${field}`);
        else walk(entry, `${path}.${field}`);
      }
    }
  };

  // Historical bet events encode monetary fields positionally:
  // [market_id, bettor, is_yes, amount, net_amount, fee, is_increase].
  if (Array.isArray(data) && (type === "bet_placed" || (type === "bet" && subtype === "placed"))) {
    for (const i of [3, 4, 5]) {
      if (data[i] !== undefined && data[i] !== null) validateAmount(data[i], `data[${i}]`);
    }
  }
  walk(data, "data");
}

export function decodeEvent(topics: xdr.ScVal[], value: xdr.ScVal): DecodedEvent {
  try {
    const { type, subtype } = decodeTopics(topics);
    const data = decodeValue(value);
    assertValidEventAmounts(type, subtype, data);
    return { type, subtype: subtype || undefined, data };
  } catch (error) {
    deadLetterHandler(error as Error, topics, value);
    throw error;
  }
}
