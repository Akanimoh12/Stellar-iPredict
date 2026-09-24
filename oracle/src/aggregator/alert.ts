import type { Logger } from "../log.js";

/**
 * Incident severity (issue #462 / #649). Anything that can lock user funds is SEV1.
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

/** A single notification channel. Receives a fully-classified alert payload. */
export interface AlertChannel {
  /** Human-readable name used in log lines (e.g. "pagerduty", "slack"). */
  name: string;
  /**
   * The minimum severity this channel handles.  A channel configured for
   * "SEV2" will receive SEV1 and SEV2 alerts but not SEV3.
   */
  minSeverity: Severity;
  /** Deliver the alert. Must never throw — errors are caught by the router. */
  send(payload: AlertPayload): Promise<void>;
}

/** The structured payload that every channel receives. */
export interface AlertPayload {
  type: "oracle.aggregator.submit_failed";
  severity: Severity;
  marketId: string;
  attempts: number;
  error: string;
}

export type AlertSender = (alert: PersistentFailureAlert) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SEVERITY_RANK: Record<Severity, number> = { SEV1: 1, SEV2: 2, SEV3: 3 };

/**
 * Returns `true` when `sev` meets or exceeds `minSev` (i.e. is at least as
 * severe — lower rank number means more severe).
 */
function meetsMinSeverity(sev: Severity, minSev: Severity): boolean {
  return SEVERITY_RANK[sev] <= SEVERITY_RANK[minSev];
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

// ---------------------------------------------------------------------------
// Deduplication / cooldown
// ---------------------------------------------------------------------------

/** Key: `${condition}:${marketId}` — matches alerts on the same fault. */
type DedupeKey = string;

interface DedupeEntry {
  lastFiredAt: number;
}

/** Default cooldown: do not re-fire the same (marketId, severity) within 15 minutes. */
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1_000;

function makeDedupeKey(marketId: string, severity: Severity): DedupeKey {
  return `${severity}:${marketId}`;
}

// ---------------------------------------------------------------------------
// Multi-channel alert router
// ---------------------------------------------------------------------------

export interface AlertRouterOptions {
  /** Ordered list of channels.  At least one channel is required for delivery. */
  channels: AlertChannel[];
  logger?: Logger;
  /**
   * Milliseconds before the same (severity, marketId) alert is re-delivered.
   * Set to `0` to disable deduplication.
   */
  cooldownMs?: number;
}

/**
 * Creates an `AlertSender` that:
 *  1. Classifies the alert severity.
 *  2. Deduplicates by (severity, marketId) with a configurable cooldown.
 *  3. Routes to every channel whose `minSeverity` is met.
 *  4. Delivers each channel in parallel; a channel failure is logged and
 *     swallowed — an alerting outage must never block the aggregator.
 */
export function createAlertRouter(options: AlertRouterOptions): AlertSender {
  const { channels, logger } = options;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const dedupeMap = new Map<DedupeKey, DedupeEntry>();

  return async (alert) => {
    const severity = classifyAlertSeverity(alert);
    const payload: AlertPayload = {
      type: "oracle.aggregator.submit_failed",
      severity,
      marketId: alert.marketId,
      attempts: alert.attempts,
      error: errorMessage(alert.error),
    };

    // ── Deduplication ──────────────────────────────────────────────────────
    if (cooldownMs > 0) {
      const key = makeDedupeKey(alert.marketId, severity);
      const entry = dedupeMap.get(key);
      const now = Date.now();
      if (entry && now - entry.lastFiredAt < cooldownMs) {
        logger?.info("alert suppressed by cooldown", {
          marketId: alert.marketId,
          severity,
          cooldownMs,
          msSinceLast: now - entry.lastFiredAt,
        });
        return;
      }
      dedupeMap.set(key, { lastFiredAt: now });
    }

    // ── Channel routing ────────────────────────────────────────────────────
    const eligible = channels.filter((ch) => meetsMinSeverity(severity, ch.minSeverity));

    if (eligible.length === 0) {
      const line = "persistent submit failure (no alert channel configured for severity)";
      if (severity === "SEV1") logger?.error(line, payload);
      else logger?.warn(line, payload);
      return;
    }

    // Deliver all eligible channels in parallel; failures are non-fatal.
    await Promise.allSettled(
      eligible.map(async (ch) => {
        try {
          await ch.send(payload);
        } catch (err) {
          logger?.error("alert channel failed to deliver", {
            channel: ch.name,
            marketId: alert.marketId,
            severity,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Built-in channels
// ---------------------------------------------------------------------------

/**
 * Creates a webhook-backed `AlertChannel`.
 *
 * Failures to deliver the webhook are logged and swallowed — an alerting
 * outage must never block the aggregator's poll loop.
 */
export function createWebhookAlertChannel(options: {
  name?: string;
  webhookUrl: string;
  minSeverity?: Severity;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}): AlertChannel {
  const { webhookUrl, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: options.name ?? "webhook",
    minSeverity: options.minSeverity ?? "SEV3",
    async send(payload) {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger?.error("alert webhook returned non-2xx", {
          marketId: payload.marketId,
          severity: payload.severity,
          status: response.status,
        });
      }
    },
  };
}

/**
 * @deprecated Use {@link createAlertRouter} with {@link createWebhookAlertChannel} instead.
 *
 * Legacy shim retained for call sites that have not yet migrated.  Routes
 * all alerts through a single webhook channel with no deduplication.
 */
export function createWebhookAlertSender(
  webhookUrl: string | undefined,
  logger?: Logger,
  fetchImpl: typeof fetch = fetch,
): AlertSender {
  if (!webhookUrl) {
    // No channel — fall back to logging only.
    return createAlertRouter({ channels: [], logger });
  }
  return createAlertRouter({
    channels: [
      createWebhookAlertChannel({
        name: "webhook",
        webhookUrl,
        minSeverity: "SEV3",
        logger,
        fetchImpl,
      }),
    ],
    logger,
    // Legacy behaviour had no cooldown.
    cooldownMs: 0,
  });
}
