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
  /** Deliver the alert. Rejections are retried and logged by the router. */
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

export interface AmbiguousTallyAlert {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  threshold: number;
}

export type AmbiguousTallyAlertSender = (alert: AmbiguousTallyAlert) => Promise<void>;

export interface BetPatternAlert {
  marketId: string;
  windowStart: string;
  bettorCount: number;
  recentNetAmount: string;
  sameSideShare: string;
}

export type BetPatternAlertSender = (alert: BetPatternAlert) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

async function deliverWebhookWithRetry(
  webhookUrl: string,
  payload: Record<string, unknown>,
  logger: Logger | undefined,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": userAgent,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`webhook returned HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < DEFAULT_MAX_RETRIES) {
        logger?.warn("webhook delivery failed; retrying", {
          attempt: attempt + 1,
          maxRetries: DEFAULT_MAX_RETRIES,
          error: errorMessage(error),
        });
        await new Promise<void>((resolve) =>
          setTimeout(resolve, DEFAULT_RETRY_DELAY_MS * 2 ** attempt),
        );
      }
    }
  }

  logger?.error("webhook delivery failed after retries", { error: errorMessage(lastError) });
  throw lastError;
}

const SEVERITY_RANK: Record<Severity, number> = { SEV1: 1, SEV2: 2, SEV3: 3 };

/**
 * Returns `true` when `sev` meets or exceeds `minSev` (i.e. is at least as
 * severe — lower rank number means more severe).
 */
function meetsMinSeverity(sev: Severity, minSev: Severity): boolean {
  return SEVERITY_RANK[sev] <= SEVERITY_RANK[minSev];
}

// ── Classify severity ─────────────────────────────────────────────────────────

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

function makeDedupeKey(marketId: string, severity: Severity, channelIndex: number): DedupeKey {
  return `${severity}:${marketId}:${channelIndex}`;
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
  /** Number of retries after the initial channel delivery attempt. */
  maxRetries?: number;
  /** Base delay for exponential channel retry backoff. */
  retryDelayMs?: number;
  /** Injectable delay for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Creates an `AlertSender` that:
 *  1. Classifies the alert severity.
 *  2. Deduplicates successful deliveries by (severity, marketId, channel).
 *  3. Routes to every channel whose `minSeverity` is met.
 *  4. Retries failed channel deliveries; an alerting outage must never block
 *     the aggregator, and failed channels remain eligible on the next call.
 */
export function createAlertRouter(options: AlertRouterOptions): AlertSender {
  const { channels, logger } = options;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("retryDelayMs must be a non-negative finite number");
  }
  const dedupeMap = new Map<DedupeKey, DedupeEntry>();
  const inFlight = new Map<DedupeKey, Promise<void>>();

  return async (alert) => {
    const severity = classifyAlertSeverity(alert);
    const payload: AlertPayload = {
      type: "oracle.aggregator.submit_failed",
      severity,
      marketId: alert.marketId,
      attempts: alert.attempts,
      error: errorMessage(alert.error),
    };

    // ── Channel routing ────────────────────────────────────────────────────
    const eligible = channels.filter((ch) => meetsMinSeverity(severity, ch.minSeverity));

    if (eligible.length === 0) {
      const line = "persistent submit failure (no alert channel configured for severity)";
      const logFields = { ...payload };
      if (severity === "SEV1") logger?.error(line, logFields);
      else logger?.warn(line, logFields);
      return;
    }

    await Promise.all(
      eligible.map(async (ch) => {
        const channelIndex = channels.indexOf(ch);
        const key = makeDedupeKey(alert.marketId, severity, channelIndex);
        const now = Date.now();
        const entry = dedupeMap.get(key);
        if (cooldownMs > 0 && entry && now - entry.lastFiredAt < cooldownMs) {
          logger?.info("alert suppressed by cooldown", {
            channel: ch.name,
            marketId: alert.marketId,
            severity,
            cooldownMs,
            msSinceLast: now - entry.lastFiredAt,
          });
          return;
        }

        const existingDelivery = inFlight.get(key);
        if (existingDelivery) {
          await existingDelivery;
          return;
        }

        const delivery = (async () => {
          for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            try {
              await ch.send(payload);
              if (cooldownMs > 0) {
                dedupeMap.set(key, { lastFiredAt: Date.now() });
              }
              return;
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              if (attempt < maxRetries) {
                logger?.warn("alert channel delivery failed; retrying", {
                  channel: ch.name,
                  marketId: alert.marketId,
                  severity,
                  attempt: attempt + 1,
                  maxRetries,
                  error,
                });
                await sleep(retryDelayMs * 2 ** attempt);
                continue;
              }
              logger?.error("alert channel failed to deliver after retries", {
                channel: ch.name,
                marketId: alert.marketId,
                severity,
                attempts: attempt + 1,
                error,
              });
            }
          }
        })();
        inFlight.set(key, delivery);
        try {
          await delivery;
        } finally {
          if (inFlight.get(key) === delivery) inFlight.delete(key);
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
 * Failed sends reject so the alert router can retry them; the router logs and
 * contains final failures so an alerting outage cannot block polling.
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
        throw new Error(`alert webhook returned HTTP ${response.status}`);
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

/** Escalates an ambiguous tally once it has been durably recorded. */
export function createAmbiguousTallyAlertSender(
  webhookUrl: string | undefined,
  logger?: Logger,
  fetchImpl: typeof fetch = fetch,
): AmbiguousTallyAlertSender {
  return async (alert) => {
    const payload = {
      type: "oracle.aggregator.ambiguous_tally",
      severity: "SEV1" as const,
      ...alert,
    };
    if (!webhookUrl) {
      logger?.error("ambiguous council tally requires manual review", payload);
      return;
    }

    try {
      await deliverWebhookWithRetry(
        webhookUrl,
        payload,
        logger,
        "ipredict-oracle-ambiguous-alerts/1.0",
        fetchImpl,
      );
    } catch (error) {
      logger?.error("failed to deliver ambiguous tally alert webhook", {
        marketId: alert.marketId,
        error,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Bond Reconciliation Alerts (Issue #573)
// ---------------------------------------------------------------------------

/**
 * Alert when a bond refund discrepancy is detected (Issue #573)
 * 
 * This is P0/SEV1 - highest severity. Any bond discrepancy means user funds 
 * are unaccounted for and requires immediate investigation.
 * 
 * Integrates with the existing webhook alerting infrastructure.
 */
export function alertBondDiscrepancy(
  marketId: string,
  submitter: string,
  expectedAmount: bigint,
  actualAmount: bigint | null,
  affectedParties: string[],
  webhookUrl?: string,
  logger?: Logger,
): void {
  const payload = {
    type: "oracle.aggregator.bond_discrepancy" as const,
    severity: "SEV1" as const,
    marketId,
    submitter,
    expectedAmountStroops: expectedAmount.toString(),
    actualAmountStroops: actualAmount?.toString() ?? null,
    affectedParties,
    impact: "User funds unaccounted for - requires immediate investigation",
  };
  
  // Always log at error level since this is SEV1
  logger?.error("bond refund discrepancy detected", payload);
  
  // Also deliver to webhook if configured
  if (webhookUrl) {
    deliverBondAlertWebhook(webhookUrl, payload, logger).catch((error) => {
      logger?.error("failed to deliver bond discrepancy alert webhook", {
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Alert when bond reconciliation job fails (Issue #573)
 * 
 * A reconciliation failure is as serious as a discrepancy - silence from
 * a broken job looks identical to silence from a healthy one.
 */
export function alertBondReconciliationFailure(
  error: Error,
  checkedCount: number,
  lastSuccessfulRun: string | null,
  webhookUrl?: string,
  logger?: Logger,
): void {
  const payload = {
    type: "oracle.aggregator.bond_reconciliation_failure" as const,
    severity: "SEV1" as const,
    error: error.message,
    stack: error.stack,
    checkedCount,
    lastSuccessfulRun: lastSuccessfulRun ?? "never",
    impact: "Bond discrepancies may go undetected",
  };
  
  logger?.error("bond reconciliation job failed", payload);
  
  if (webhookUrl) {
    deliverBondAlertWebhook(webhookUrl, payload, logger).catch((err) => {
      logger?.error("failed to deliver bond reconciliation failure alert webhook", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ── createWebhookAlertSender (used by alert.test.ts + index.ts) ───────────────

/**
 * Helper to deliver bond alerts to webhook (fire-and-forget)
 */
async function deliverBondAlertWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>,
  logger?: Logger,
): Promise<void> {
  await deliverWebhookWithRetry(webhookUrl, payload, logger, "ipredict-oracle-bond-alerts/1.0");
}

// ---------------------------------------------------------------------------
// Monitoring Alerts (Issues #569, #571)
// ---------------------------------------------------------------------------

/**
 * Alert when circuit breaker opens for an adapter (Issue #569)
 * 
 * Uses the existing webhook infrastructure.
 */
export function alertCircuitBreakerOpen(
  adapterName: string,
  failureRate: number,
  webhookUrl?: string,
  logger?: Logger,
): void {
  const payload = {
    type: "oracle.aggregator.circuit_breaker_open" as const,
    severity: "SEV2" as const, // Not funds-at-risk, but degrades multi-source guarantee
    adapter: adapterName,
    failureRate,
    failureRatePercent: (failureRate * 100).toFixed(1),
    impact: "Multi-source guarantee weakened",
  };
  
  logger?.warn("circuit breaker opened", payload);
  
  if (webhookUrl) {
    deliverMonitoringAlertWebhook(webhookUrl, payload, logger).catch((error) => {
      logger?.error("failed to deliver circuit breaker alert webhook", {
        adapter: adapterName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// ── createAmbiguousTallyAlertSender ──────────────────────────────────────────

/**
 * Alert when a market is stuck past resolution lag threshold (Issue #571)
 */
export function alertStuckMarket(
  marketId: string,
  lagHours: number,
  webhookUrl?: string,
  logger?: Logger,
): void {
  const severity: Severity = lagHours >= 6 ? "SEV1" : "SEV2";
  const payload = {
    type: "oracle.aggregator.stuck_market" as const,
    severity,
    marketId,
    lagHours,
    threshold: 6,
  };
  
  if (severity === "SEV1") {
    logger?.error("market stuck - critical lag", payload);
  } else {
    logger?.warn("market stuck - warning lag", payload);
  }
  
  if (webhookUrl) {
    deliverMonitoringAlertWebhook(webhookUrl, payload, logger).catch((error) => {
      logger?.error("failed to deliver stuck market alert webhook", {
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Helper to deliver monitoring alerts to webhook (fire-and-forget)
 */
async function deliverMonitoringAlertWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>,
  logger?: Logger,
): Promise<void> {
  await deliverWebhookWithRetry(webhookUrl, payload, logger, "ipredict-oracle-monitoring-alerts/1.0");
}

/** Routes a detected betting pattern to review without intervening in a market. */
export function createBetPatternAlertSender(
  webhookUrl: string | undefined,
  logger?: Logger,
  fetchImpl: typeof fetch = fetch,
): BetPatternAlertSender {
  return async (alert) => {
    const payload = {
      type: "indexer.bet_pattern.detected",
      action: "manual_review_only",
      ...alert,
    };
    if (!webhookUrl) {
      logger?.warn("betting pattern requires manual review", payload);
      return;
    }
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger?.error("betting pattern alert webhook returned non-2xx", {
          marketId: alert.marketId,
          status: response.status,
        });
      }
    } catch (error) {
      logger?.error("failed to deliver betting pattern alert webhook", {
        marketId: alert.marketId,
        error,
      });
    }
  };
}
