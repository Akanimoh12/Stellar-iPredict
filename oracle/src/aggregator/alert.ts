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

export interface AmbiguousTallyAlert {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  threshold: number;
}

export type AmbiguousTallyAlertSender = (alert: AmbiguousTallyAlert) => Promise<void>;

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
      const logFields = { ...payload };
      if (severity === "SEV1") logger?.error(line, logFields);
      else logger?.warn(line, logFields);
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
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger?.error("ambiguous tally alert webhook returned non-2xx", {
          marketId: alert.marketId,
          status: response.status,
        });
      }
    } catch (error) {
      logger?.error("failed to deliver ambiguous tally alert webhook", {
        marketId: alert.marketId,
        error,
      });
    }
  };
}

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

export interface AmbiguousTallyAlert {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  threshold: number;
}

export type AmbiguousTallyAlertSender = (alert: AmbiguousTallyAlert) => Promise<void>;

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
      const logFields = { ...payload };
      if (severity === "SEV1") logger?.error(line, logFields);
      else logger?.warn(line, logFields);
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
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger?.error("ambiguous tally alert webhook returned non-2xx", {
          marketId: alert.marketId,
          status: response.status,
        });
      }
    } catch (error) {
      logger?.error("failed to deliver ambiguous tally alert webhook", {
        marketId: alert.marketId,
        error,
      });
    }
  };
}

/**
 * Oracle alert deduplication, grouping, cooldown, and routing (issue #583).
 *
 * ## Problem
 *
 * The aggregator polls every 5 seconds by default. Without deduplication every
 * detected condition — a stuck market, a low bond, a council inactivity — fires
 * a webhook on every poll. That is hundreds of identical notifications per hour,
 * which trains responders to ignore the channel.
 *
 * ## Design
 *
 * ### Deduplication key
 * Each active condition is identified by a (type, entityId) pair. "Stuck market
 * 42" has key `stuck_market:42`; "circuit breaker open for CoinGecko" has key
 * `circuit_breaker:CoinGecko`. The first time a key is seen the alert fires
 * immediately. Subsequent detections of the same key are suppressed until the
 * cooldown window elapses.
 *
 * ### Cooldown
 * A re-notification is sent at most once per `cooldownMs` (default 15 min,
 * configurable via `ALERT_COOLDOWN_MS`). This bounds the noise from a condition
 * that persists for hours while still re-alerting if it is not acknowledged.
 *
 * ### Resolution notification
 * When a condition that was previously active disappears, a one-shot
 * `resolved` notification is sent immediately. Responders can tell whether
 * they need to act or whether the condition self-healed.
 *
 * ### Grouping
 * Multiple conditions detected in the same poll cycle are batched into a single
 * POST, reducing webhook traffic when many markets are stuck simultaneously.
 * Each group is keyed on (type, severity); alerts within a group share a
 * `groupKey` field that consumers can use for thread correlation.
 *
 * ### Channels
 * Channels are pluggable. The production stack uses one webhook channel, but
 * the interface supports adding Slack, PagerDuty, etc. without touching the
 * router. Each channel declares a `minSeverity` so low-severity noise is not
 * paged to on-call.
 *
 * ### AlertRouter
 * `createAlertRouter` owns the deduplication state. It is created once at
 * process startup (see `startAggregator` in index.ts) and injected into
 * `runAggregator` as `options.alertSender`. The router is purely in-memory;
 * state is lost on restart, which is acceptable — a fresh start is itself a
 * signal that something happened.
 */

import type { Logger } from "../log.js";

// ── Severity ──────────────────────────────────────────────────────────────────

/**
 * SEV1 — user funds at risk (bond discrepancy, unresolved market with funds locked).
 * SEV2 — persistent, non-fund failure (5+ consecutive submit failures).
 * SEV3 — likely transient (few failures, circuit breaker open but no fund risk).
 */
export type AlertSeverity = "SEV1" | "SEV2" | "SEV3";

const SEVERITY_ORDER: AlertSeverity[] = ["SEV3", "SEV2", "SEV1"];

function severityIndex(s: AlertSeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}

function meetsMinSeverity(actual: AlertSeverity, min: AlertSeverity): boolean {
  return severityIndex(actual) >= severityIndex(min);
}

// ── Alert payload ─────────────────────────────────────────────────────────────

export interface AlertPayload {
  marketId?: string;
  attempts?: number;
  error?: Error | unknown;
  holdsFunds?: boolean;
  /** Additional free-form context fields. */
  [key: string]: unknown;
}

/** A complete alert ready to route. */
export interface Alert {
  type: string;
  severity: AlertSeverity;
  /** The entity this alert concerns — used as the deduplication key alongside `type`. */
  entityId: string;
  payload: AlertPayload;
  /** ISO-8601 timestamp when this occurrence was first detected. */
  firedAt: string;
  /** True when this notification is a resolution (the condition cleared). */
  resolved?: boolean;
  /**
   * Groups alerts of the same (type, severity) detected in the same poll cycle.
   * Consumers can thread webhook messages by this value.
   */
  groupKey?: string;
}

// ── Classify severity ─────────────────────────────────────────────────────────

/**
 * Assigns a severity level to a market-processing failure alert.
 *
 * Rules (applied in order):
 * 1. Any failure where `holdsFunds` is true → SEV1.
 * 2. Error message contains words indicating a bond or stake issue → SEV1.
 * 3. 5+ consecutive failures → SEV2 (persistent but no confirmed fund risk).
 * 4. Fewer failures → SEV3 (likely transient).
 */
export function classifyAlertSeverity(payload: {
  marketId: string;
  attempts: number;
  error: Error | unknown;
  holdsFunds?: boolean;
}): AlertSeverity {
  if (payload.holdsFunds) return "SEV1";

  const message =
    payload.error instanceof Error
      ? payload.error.message.toLowerCase()
      : String(payload.error).toLowerCase();

  const fundKeywords = ["bond", "stake", "balance", "discrepancy", "mismatch", "escrow"];
  if (fundKeywords.some((kw) => message.includes(kw))) return "SEV1";

  if (payload.attempts >= 5) return "SEV2";

  return "SEV3";
}

// ── Deduplication state ───────────────────────────────────────────────────────

interface ActiveCondition {
  /** When this condition first fired. */
  firstFiredAt: number;
  /** When the most recent notification was sent (initial or re-notification). */
  lastNotifiedAt: number;
  /** Monotonically increasing count of poll cycles this condition has been seen. */
  occurrences: number;
}

/** Key = `${type}:${entityId}`. */
type DedupeKey = string;

function dedupeKey(type: string, entityId: string): DedupeKey {
  return `${type}:${entityId}`;
}

// ── Channels ──────────────────────────────────────────────────────────────────

export interface AlertChannel {
  name: string;
  minSeverity: AlertSeverity;
  send(alerts: Alert[]): Promise<void>;
}

// ── createWebhookAlertChannel ─────────────────────────────────────────────────

export interface WebhookAlertChannelOptions {
  name: string;
  webhookUrl: string;
  minSeverity?: AlertSeverity;
  logger?: Logger;
  fetchFn?: typeof fetch;
}

/**
 * Creates an `AlertChannel` that POSTs batched alert payloads to a webhook.
 *
 * Delivery failures are logged and swallowed — a broken webhook must never
 * stop the aggregator from running.
 */
export function createWebhookAlertChannel(options: WebhookAlertChannelOptions): AlertChannel {
  const {
    name,
    webhookUrl,
    minSeverity = "SEV3",
    logger,
    fetchFn = fetch,
  } = options;

  return {
    name,
    minSeverity,
    async send(alerts: Alert[]): Promise<void> {
      // Filter to alerts this channel cares about.
      const eligible = alerts.filter((a) => meetsMinSeverity(a.severity, minSeverity));
      if (eligible.length === 0) return;

      const body = JSON.stringify({
        alerts: eligible.map(serializeAlertForWire),
        sentAt: new Date().toISOString(),
        count: eligible.length,
      });

      try {
        const response = await fetchFn(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) {
          logger?.warn("alert webhook returned non-2xx", {
            channel: name,
            status: response.status,
            count: eligible.length,
          });
        } else {
          logger?.debug("alert batch delivered", { channel: name, count: eligible.length });
        }
      } catch (err) {
        logger?.warn("failed to deliver alert webhook", {
          channel: name,
          error: err instanceof Error ? err.message : String(err),
          count: eligible.length,
        });
      }
    },
  };
}

// ── AlertRouter ───────────────────────────────────────────────────────────────

export interface AlertRouterOptions {
  channels: AlertChannel[];
  logger?: Logger;
  cooldownMs?: number;
  /** Injected time source for deterministic tests. */
  clock?: () => number;
}

export interface AlertRouter {
  /**
   * Routes a single alert payload through the deduplication and cooldown
   * logic. Used as `options.alertSender` in `runAggregator`.
   */
  (payload: AlertPayload): Promise<void>;

  /**
   * Notify the router that a set of conditions are currently active (present
   * in this poll cycle). Conditions NOT present that were previously active
   * will trigger a resolution notification.
   *
   * @param currentKeys  Set of `${type}:${entityId}` keys active this cycle.
   * @param nowMs        Current timestamp in milliseconds.
   */
  reconcile(currentKeys: Set<DedupeKey>, nowMs?: number): Promise<void>;

  /**
   * Flush a batch of alerts through the channels in a single grouped
   * delivery. Called at the end of a poll cycle.
   */
  flush(): Promise<void>;

  /** Snapshot of currently active deduplicated conditions (for testing). */
  activeConditions(): ReadonlyMap<DedupeKey, ActiveCondition>;

  /** Clears all deduplication state. Intended for tests only. */
  _reset(): void;
}

/**
 * Creates an `AlertRouter` that owns deduplication state and routes alerts
 * through one or more `AlertChannel`s.
 *
 * ### Deduplication algorithm
 *
 * On each call with a (type, entityId) pair:
 * 1. If no active condition exists → fire immediately, record state.
 * 2. If active condition exists and `now - lastNotifiedAt < cooldownMs` → suppress.
 * 3. If active condition exists and cooldown elapsed → re-notify, update `lastNotifiedAt`.
 *
 * ### Resolution
 * Call `reconcile(activeKeySet)` at the end of each poll cycle.
 * Keys that were in the active-conditions map but are absent from `activeKeySet`
 * trigger a one-shot `resolved: true` notification, then are removed from state.
 */
export function createAlertRouter(options: AlertRouterOptions): AlertRouter {
  const {
    channels,
    logger,
    cooldownMs = 15 * 60 * 1_000,
    clock = () => Date.now(),
  } = options;

  const active = new Map<DedupeKey, ActiveCondition>();
  // Batch of alerts accumulated this cycle; flushed at end of poll.
  let pending: Alert[] = [];

  async function dispatch(alerts: Alert[]): Promise<void> {
    if (alerts.length === 0) return;

    // Log each alert.
    for (const alert of alerts) {
      const level = alert.resolved ? "info" : alert.severity === "SEV1" ? "error" : "warn";
      logger?.[level]("oracle alert", {
        alertType: alert.type,
        entityId: alert.entityId,
        severity: alert.severity,
        resolved: alert.resolved ?? false,
        occurrences: active.get(dedupeKey(alert.type, alert.entityId))?.occurrences,
      });
    }

    // Group by (type, severity) for a single delivery per group per cycle.
    const groups = new Map<string, Alert[]>();
    for (const alert of alerts) {
      const gk = `${alert.type}:${alert.severity}`;
      let group = groups.get(gk);
      if (!group) {
        group = [];
        groups.set(gk, group);
      }
      group.push({ ...alert, groupKey: gk });
    }

    // Deliver each group to all channels that accept its severity.
    for (const [, groupAlerts] of groups) {
      // Pre-filter alerts to the channel's minSeverity so channels receive
      // only what they care about — even when a channel's send() doesn't filter.
      await Promise.all(
        channels.map((ch) => {
          const eligible = groupAlerts.filter((a) => meetsMinSeverity(a.severity, ch.minSeverity));
          if (eligible.length === 0) return Promise.resolve();
          return ch.send(eligible).catch((err) => {
            logger?.warn("channel delivery error", {
              channel: ch.name,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        })
      );
    }
  }

  // The callable function (used as options.alertSender in runAggregator).
  async function router(payload: AlertPayload): Promise<void> {
    const now = clock();
    const type = "oracle.aggregator.submit_failed";
    const entityId = String(payload.marketId ?? "unknown");
    const key = dedupeKey(type, entityId);
    const severity = classifyAlertSeverity({
      marketId: entityId,
      attempts: typeof payload.attempts === "number" ? payload.attempts : 0,
      error: payload.error,
      holdsFunds: typeof payload.holdsFunds === "boolean" ? payload.holdsFunds : undefined,
    });

    const condition = active.get(key);
    if (condition) {
      condition.occurrences += 1;
      const elapsed = now - condition.lastNotifiedAt;
      if (elapsed < cooldownMs) {
        // Within cooldown — suppress.
        return;
      }
      // Cooldown elapsed → re-notify.
      condition.lastNotifiedAt = now;
    } else {
      // First occurrence → fire immediately.
      active.set(key, { firstFiredAt: now, lastNotifiedAt: now, occurrences: 1 });
    }

    const alert: Alert = {
      type,
      severity,
      entityId,
      payload,
      firedAt: new Date(now).toISOString(),
    };

    // Dispatch immediately (not batched) — submit failures are urgent.
    await dispatch([alert]);
  }

  router.reconcile = async function reconcile(
    currentKeys: Set<DedupeKey>,
    nowMs?: number,
  ): Promise<void> {
    const now = nowMs ?? clock();
    const resolutions: Alert[] = [];

    for (const [key, condition] of active) {
      if (!currentKeys.has(key)) {
        // Condition cleared — send resolution notification.
        const [type, ...entityParts] = key.split(":");
        const entityId = entityParts.join(":");
        resolutions.push({
          type: type ?? key,
          severity: "SEV3", // resolutions are informational
          entityId,
          payload: { firstFiredAt: condition.firstFiredAt, occurrences: condition.occurrences },
          firedAt: new Date(now).toISOString(),
          resolved: true,
        });
        active.delete(key);
      }
    }

    if (resolutions.length > 0) {
      await dispatch(resolutions);
    }

    // Flush the accumulated batch from this cycle.
    await router.flush();
  };

  router.flush = async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    await dispatch(batch);
  };

  router.activeConditions = function activeConditions(): ReadonlyMap<DedupeKey, ActiveCondition> {
    return active;
  };

  router._reset = function _reset(): void {
    active.clear();
    pending = [];
  };

  return router;
}

// ── createWebhookAlertSender (used by alert.test.ts + index.ts) ───────────────

/**
 * Creates a simple single-alert webhook sender used by `runAggregator` as
 * `options.alertSender`. It does not deduplicate — deduplication is handled
 * by `createAlertRouter`. When `createAlertRouter` is used, this function is
 * not called directly; it exists for backwards compatibility and direct use in
 * simpler setups.
 *
 * Delivery errors are swallowed so a broken webhook cannot stop the aggregator.
 */
export function createWebhookAlertSender(
  webhookUrl: string | undefined,
  _unused?: unknown,
  fetchFn: typeof fetch = fetch,
): (payload: AlertPayload) => Promise<void> {
  return async function sendAlert(payload: AlertPayload): Promise<void> {
    if (!webhookUrl) return;

    const severity = classifyAlertSeverity({
      marketId: String(payload.marketId ?? "unknown"),
      attempts: typeof payload.attempts === "number" ? payload.attempts : 0,
      error: payload.error,
      holdsFunds: typeof payload.holdsFunds === "boolean" ? payload.holdsFunds : undefined,
    });

    const body = JSON.stringify({
      type: "oracle.aggregator.submit_failed",
      marketId: payload.marketId,
      attempts: payload.attempts,
      error: payload.error instanceof Error ? payload.error.message : String(payload.error ?? ""),
      severity,
      sentAt: new Date().toISOString(),
    });

    try {
      const response = await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) {
        // Non-2xx: log and swallow.
        console.warn("[oracle] alert webhook returned non-2xx", { status: response.status });
      }
    } catch (_err) {
      // Network error: swallow silently — a broken webhook must not stop
      // the aggregator.
    }
  };
}

// ── createAmbiguousTallyAlertSender ──────────────────────────────────────────

/**
 * Creates a sender that fires a webhook when the council reaches an ambiguous
 * tally (no YES/NO threshold met) and a market is held for manual review.
 *
 * Uses the same deduplication logic as the main router: fires once immediately,
 * then re-fires at most once per 15 minutes if the condition persists.
 */
export function createAmbiguousTallyAlertSender(
  webhookUrl: string | undefined,
  logger?: Logger,
  fetchFn: typeof fetch = fetch,
): (alert: {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  threshold: number;
}) => Promise<void> {
  // In-process cooldown map: marketId → lastSentAt.
  const cooldownMap = new Map<string, number>();
  const COOLDOWN_MS = 15 * 60 * 1_000;

  return async function sendAmbiguousTallyAlert(alert): Promise<void> {
    if (!webhookUrl) return;

    const now = Date.now();
    const last = cooldownMap.get(alert.marketId);
    if (last !== undefined && now - last < COOLDOWN_MS) {
      // Within cooldown — suppress duplicate.
      return;
    }
    cooldownMap.set(alert.marketId, now);

    const body = JSON.stringify({
      type: "oracle.aggregator.ambiguous_tally",
      marketId: alert.marketId,
      yesVotes: alert.yesVotes,
      noVotes: alert.noVotes,
      threshold: alert.threshold,
      severity: "SEV2",
      sentAt: new Date(now).toISOString(),
    });

    try {
      const response = await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) {
        logger?.warn("ambiguous tally webhook returned non-2xx", { status: response.status });
      }
    } catch (err) {
      logger?.warn("failed to deliver ambiguous tally webhook", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

// ── Wire serialization helpers ────────────────────────────────────────────────

function serializeAlertForWire(alert: Alert): Record<string, unknown> {
  const { payload, ...rest } = alert;
  const serializedPayload: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(payload)) {
    if (v instanceof Error) {
      serializedPayload[k] = v.message;
    } else if (typeof v === "bigint") {
      serializedPayload[k] = String(v);
    } else {
      serializedPayload[k] = v;
    }
  }

  return { ...rest, ...serializedPayload };
}

// ── Legacy thresholds (kept for any callers that imported THRESHOLDS) ────────

export const THRESHOLDS = {
  RESOLUTION_LAG_WARNING_HOURS: 2,
  RESOLUTION_LAG_CRITICAL_HOURS: 6,
  AGGREGATE_LAG_WARNING_HOURS: 1,
  STUCK_MARKET_HOURS: 6,
} as const;
