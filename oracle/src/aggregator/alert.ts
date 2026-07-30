import type { Logger } from "../log.js";

export interface PersistentFailureAlert {
  marketId: string;
  attempts: number;
  error: unknown;
}

export type AlertSender = (alert: PersistentFailureAlert) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Posts a persistent-submission-failure alert to a webhook. Failures to
 * deliver the alert itself are logged, not thrown — an alerting outage must
 * never block the aggregator's poll loop.
 */
export function createWebhookAlertSender(
  webhookUrl: string | undefined,
  logger?: Logger,
  fetchImpl: typeof fetch = fetch,
): AlertSender {
  return async (alert) => {
    if (!webhookUrl) {
      logger?.warn("persistent submit failure (no alert webhook configured)", {
        marketId: alert.marketId,
        attempts: alert.attempts,
        error: errorMessage(alert.error),
      });
      return;
    }

    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "oracle.aggregator.submit_failed",
          marketId: alert.marketId,
          attempts: alert.attempts,
          error: errorMessage(alert.error),
        }),
      });

      if (!response.ok) {
        logger?.error("alert webhook returned non-2xx", {
          marketId: alert.marketId,
          status: response.status,
        });
      }
    } catch (error) {
      logger?.error("failed to deliver alert webhook", {
        marketId: alert.marketId,
        error,
      });
    }
  };
}
