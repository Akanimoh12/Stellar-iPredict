import { handleClaim, REWARD_CLAIMED_TOPIC } from "./claim.js";
import { handleFeeWithdrawn, FEES_WITHDRAWN_TOPIC } from "./fee_withdrawn.js";
import { handleRewardPoints, REWARD_POINTS_TOPIC } from "./reward_points.js";
import { handleTokenMint, TOKEN_MINT_TOPIC } from "./token_mint.js";
import type { DecodedEvent, EventHandler, HandlerContext } from "./types.js";

export const eventHandlers = {
  [REWARD_CLAIMED_TOPIC]: handleClaim,
  [FEES_WITHDRAWN_TOPIC]: handleFeeWithdrawn,
  [REWARD_POINTS_TOPIC]: handleRewardPoints,
  [TOKEN_MINT_TOPIC]: handleTokenMint,
} satisfies Record<string, EventHandler>;

export type EventTopic = keyof typeof eventHandlers;

export function getEventTopic(event: DecodedEvent): string | undefined {
  const [topic] = event.topics;
  return typeof topic === "string" ? topic : undefined;
}

export async function dispatchEvent(
  event: DecodedEvent,
  context: HandlerContext,
  registry: Record<string, EventHandler> = eventHandlers,
): Promise<void> {
  const topic = getEventTopic(event);
  const handler = topic ? registry[topic] : undefined;

  if (!topic || !handler) {
    context.logger.warn("Skipping unknown indexer event type", {
      topic,
      topics: event.topics,
      ledger: event.ledger,
      txHash: event.txHash,
    });
    return;
  }

  await handler(event, context);
}

export type { DecodedEvent, EventHandler, HandlerContext } from "./types.js";
export { decodeClaim, handleClaim, REWARD_CLAIMED_TOPIC } from "./claim.js";
export { decodeFeeWithdrawn, handleFeeWithdrawn, FEES_WITHDRAWN_TOPIC } from "./fee_withdrawn.js";
export { decodeRewardPoints, handleRewardPoints, REWARD_POINTS_TOPIC } from "./reward_points.js";
export { decodeTokenMint, handleTokenMint, TOKEN_MINT_TOPIC } from "./token_mint.js";
