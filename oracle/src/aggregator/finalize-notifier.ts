import type { CouncilVote } from "./threshold.js";

/**
 * Emits a notification when a market is finalized.
 *
 * A notification is a side effect that must only ever fire for a *successful,
 * first-time* finalization. Callers wire this after `persistFinalDecision`
 * succeeds — that write is guarded by a UNIQUE(market_id) constraint, so a
 * second finalize attempt throws `MarketAlreadyFinalizedError` before we get
 * here. The notifier therefore never announces the same market twice.
 */
export interface FinalizeNotification {
  marketId: string;
  decision: boolean;
  txHash: string;
  councilVotes: readonly CouncilVote[];
  finalizedAt: string;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface FinalizeNotifierOptions {
  /** Optional webhook URL. When unset, the notifier only logs. */
  webhookUrl?: string;
  /** Injected for testing; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function decisionLabel(decision: boolean): string {
  return decision ? "yes" : "no";
}

/**
 * Delivers a finalize notification.
 *
 * Delivery is best-effort: a webhook failure is logged and swallowed so it can
 * never roll back or re-trigger an already-persisted finalization. Returns
 * `true` when the webhook was delivered (or when there was no webhook to call
 * and the event was logged), `false` when a configured webhook failed.
 */
export async function notifyFinalized(
  notification: FinalizeNotification,
  options: FinalizeNotifierOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? console;
  const summary = {
    marketId: notification.marketId,
    decision: decisionLabel(notification.decision),
    txHash: notification.txHash,
    voters: notification.councilVotes.length,
    finalizedAt: notification.finalizedAt,
  };

  // Always log — this is the audit-friendly baseline that needs no config.
  logger.info(`Market ${notification.marketId} finalized`, summary);

  if (!options.webhookUrl) {
    return true;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchFn(options.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "market_finalized", ...summary }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(`Finalize webhook returned ${response.status} for market ${notification.marketId}`, summary);
      return false;
    }
    return true;
  } catch (error) {
    logger.warn(`Finalize webhook failed for market ${notification.marketId}`, {
      ...summary,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
