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
    type: String(decoded[0] ?/ ""),
    subtype: decoded.length > 1 ? String(decoded[1]) : undefined,
    args: decoded.slice(2),
  };
}

export function decodeValue(value: xdr.ScVal): unknown {
  return scValToNative(value);
}

export function decodeEvent(topics: xdr.ScVal[], value: xdr.ScVal): DecodedEvent {
  try {
    const { type, subtype } = decodeTopics(topics);
    const data = decodeValue(value);
    return { type, subtype: subtype || undefined, data };
  } catch (error) {
    deadLetterHandler(error as Error, topics, value);
    throw error;
  }
}
