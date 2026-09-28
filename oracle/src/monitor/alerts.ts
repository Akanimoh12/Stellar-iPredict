import type { Logger } from "../log.js";

/**
 * Every alert the monitor can raise. The string is the webhook `type` field
 * and the log message, so it is part of the operator-facing contract — treat
 * a rename as a breaking change for anything consuming the webhook.
 */
export type AlertType =
  | "oracle.monitor.market_stuck"
  | "oracle.monitor.submission_new"
  | "oracle.monitor.dispute_escalated"
  | "oracle.monitor.bond_below_minimum"
  | "oracle.monitor.council_inactive"
  | "oracle.monitor.council_window_exceeded";

/**
 * Canonical runbook URL for each alert type.
 *
 * These links are embedded in every webhook payload so an engineer receiving
 * an alert at 3 am can follow the link directly without first finding this
 * codebase or the index. Update this map whenever a runbook is moved or a
 * new alert type is added — and add a row to docs/RUNBOOK_INDEX.md.
 *
 * Base path assumes the GitHub repository default-branch URL. Override
 * RUNBOOK_BASE_URL in the environment to point at an internal mirror.
 */
const RUNBOOK_BASE =
  process.env["RUNBOOK_BASE_URL"] ??
  "https://github.com/Akanimoh12/Stellar-iPredict/blob/main";

export const ALERT_RUNBOOK_URLS: Record<AlertType, string> = {
  "oracle.monitor.market_stuck": `${RUNBOOK_BASE}/oracle/docs/STUCK_MARKET_RUNBOOK.md`,
  "oracle.monitor.submission_new": `${RUNBOOK_BASE}/oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-1--submit-operation`,
  "oracle.monitor.dispute_escalated": `${RUNBOOK_BASE}/oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-2--challenge-operation`,
  "oracle.monitor.bond_below_minimum": `${RUNBOOK_BASE}/oracle/docs/OPTIMISTIC_ORACLE_RUNBOOK.md#part-4--monitoring`,
  "oracle.monitor.council_inactive": `${RUNBOOK_BASE}/oracle/docs/COUNCIL_RUNBOOK.md#monitoring--alerts`,
  "oracle.monitor.council_window_exceeded": `${RUNBOOK_BASE}/oracle/docs/COUNCIL_FLOW_RUNBOOK.md#handling-escalated-disputes-exceeding-the-council-window`,
};

export interface Alert {
  type: AlertType;
  /**
   * The alert body, spread into the webhook JSON alongside `type`. Typed as
   * `object` rather than `Record<string, unknown>` so the interface-typed
   * alert shapes exported by `aggregator/` can be passed through unchanged.
   */
  payload: object;
}

export type AlertEmitter = (alert: Alert) => Promise<void>;

/**
 * Bond amounts are `bigint` (stroops), which `JSON.stringify` throws on.
 * Stringify them instead of losing precision through `Number`.
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function serializeAlert(alert: Alert): string {
  return JSON.stringify(
    {
      type: alert.type,
      runbook_url: ALERT_RUNBOOK_URLS[alert.type],
      ...alert.payload,
    },
    replacer,
  );
}

function logFields(payload: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}

/**
 * Logs every alert and, when a webhook is configured, POSTs it as JSON.
 *
 * Every payload includes a `runbook_url` field so the receiving engineer can
 * navigate directly to the procedure without searching for documentation.
 *
 * Delivery failures are logged, never thrown: an alerting outage must not
 * stop the monitor's check cycle, which would turn one broken webhook into a
 * total loss of oracle observability.
 */
export function createAlertEmitter(
  webhookUrl: string | undefined,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): AlertEmitter {
  return async (alert) => {
    logger.warn(alert.type, {
      runbook_url: ALERT_RUNBOOK_URLS[alert.type],
      ...logFields(alert.payload),
    });

    if (!webhookUrl) return;

    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serializeAlert(alert),
      });
      if (!response.ok) {
        logger.error("alert webhook returned non-2xx", {
          type: alert.type,
          status: response.status,
        });
      }
    } catch (error) {
      logger.error("failed to deliver alert webhook", { type: alert.type, error });
    }
  };
}
