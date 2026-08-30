import type { Logger } from "../log.js";

/**
 * Incident severity (issue #649). Anything that can lock user funds is SEV1.
 * See `oracle/docs/COUNCIL_RUNBOOK.md` § "Incident Response" for the full
 * table, escalation path, and post-incident review process.
 */
export type Severity = "SEV1" | "SEV2" | "SEV3";

export interface PersistentFailureAlert {
  marketId: string;
  attempts: number;
  error: unknown;
  /**
   * When known, whether the failing market currently holds user stakes. A
   * stuck market that holds funds is always SEV1 regardless of the error.
   */
  holdsFunds?: boolean;
}

export type AlertSender = (alert: PersistentFailureAlert) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a persistent submission failure.
 *
 * - **SEV1** — the market holds user stakes and cannot finalize: funds are
 *   locked. Also any error that names a bond/stake discrepancy.
 * - **SEV2** — persistent finalization failure with no confirmed fund impact
 *   (e.g. RPC/contract errors, config problems) — degraded, not yet locking.
 * - **SEV3** — a small number of attempts; likely transient, worth surfacing
 *   but not paging.
 */
export function classifyAlertSeverity(alert: PersistentFailureAlert): Severity {
  const msg = errorMessage(alert.error).toLowerCase();
  const fundKeyword = /(bond|stake|balance|discrepanc|insufficient|underfunded|mismatch)/.test(msg);

  if (alert.holdsFunds === true || fundKeyword) {
    return "SEV1";
  }
  if (alert.attempts >= 5) {
    return "SEV2";
  }
  return "SEV3";
}

/**
 * Posts a persistent-submission-failure alert to a webhook. Failures to
 * deliver the alert itself are logged, not thrown — an alerting outage must
 * never block the aggregator's poll loop.
 *
 * The payload carries a `severity` (issue #649) so the receiving system can
 * route SEV1 to a pager and SEV3 to a channel.
 */
export function createWebhookAlertSender(
  webhookUrl: string | undefined,
  logger?: Logger,
  fetchImpl: typeof fetch = fetch,
): AlertSender {
  return async (alert) => {
    const severity = classifyAlertSeverity(alert);
    const context = {
      marketId: alert.marketId,
      attempts: alert.attempts,
      severity,
      error: errorMessage(alert.error),
    };

    if (!webhookUrl) {
      const line = "persistent submit failure (no alert webhook configured)";
      if (severity === "SEV1") logger?.error(line, context);
      else logger?.warn(line, context);
      return;
    }

    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "oracle.aggregator.submit_failed",
          severity,
          marketId: alert.marketId,
          attempts: alert.attempts,
          error: errorMessage(alert.error),
        }),
      });

      if (!response.ok) {
        logger?.error("alert webhook returned non-2xx", {
          marketId: alert.marketId,
          severity,
          status: response.status,
        });
      }
    } catch (error) {
      logger?.error("failed to deliver alert webhook", {
        marketId: alert.marketId,
        severity,
        error,
      });
    }
  };
}
