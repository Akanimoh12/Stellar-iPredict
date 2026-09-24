import crypto from "node:crypto";
import { REQUEST_ID_HEADER } from "../log.js";
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
  /** Id of the processing attempt that finalized the market (#467). */
  correlationId?: string;
  /** Backend request id of the HTTP submission for this market, if there was one. */
  originRequestId?: string;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Persistence (issue #460) — undelivered notifications survive restarts
// ---------------------------------------------------------------------------

/** Minimal queryable surface needed for persisting failed notifications. */
export interface NotificationStore {
  /**
   * Persist a notification that exhausted all delivery attempts so it can be
   * inspected / replayed by operators.  Must never throw.
   */
  persistFailed(notification: FinalizeNotification, lastError: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Webhook signing (issue #461)
// ---------------------------------------------------------------------------

/**
 * Sign a webhook delivery.
 *
 * The signed material is `${timestamp}.${bodyString}` — including the
 * timestamp binds each signature to its delivery window and prevents replay.
 *
 * @param secret     - WEBHOOK_SIGNING_SECRET (raw string, not hex-encoded)
 * @param timestamp  - Unix seconds of the delivery attempt
 * @param body       - The exact serialised JSON body that will be sent
 * @returns          - Hex-encoded HMAC-SHA256 of `${timestamp}.${body}`
 */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Exponential backoff with jitter (issue #460)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 4;
/** Base delay before the first retry (ms). */
const DEFAULT_BACKOFF_BASE_MS = 500;
/** Hard cap on any single inter-retry sleep (ms). */
const DEFAULT_BACKOFF_CAP_MS = 30_000;

/** Full-jitter exponential backoff: `rand(0, min(cap, base * 2^attempt))`. */
function backoffMs(attempt: number, base: number, cap: number): number {
  const ceiling = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceiling);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FinalizeNotifierOptions {
  /** Optional webhook URL. When unset, the notifier only logs. */
  webhookUrl?: string;
  /**
   * Dedicated webhook signing secret (issue #461).
   *
   * When set, every delivery adds `X-Signature` and `X-Timestamp` headers.
   * The signature covers `${timestamp}.${rawBody}` using HMAC-SHA256.
   *
   * Receivers should:
   *  1. Read `X-Timestamp` (Unix seconds).
   *  2. Reject deliveries whose timestamp is > 5 minutes old.
   *  3. Compute `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`.
   *  4. Compare (timing-safe) against the hex value in `X-Signature`.
   *
   * Keep this value secret and distinct from any API key.
   */
  webhookSigningSecret?: string;
  /** Injected for testing; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** Request timeout in milliseconds (per attempt). */
  timeoutMs?: number;
  /**
   * Maximum delivery attempts (initial + retries). Default: 5 (1 + 4 retries).
   * (issue #460)
   */
  maxAttempts?: number;
  /**
   * Base backoff in milliseconds for exponential-backoff-with-jitter.
   * (issue #460)
   */
  backoffBaseMs?: number;
  /**
   * Hard cap on inter-retry sleep in milliseconds. (issue #460)
   */
  backoffCapMs?: number;
  /**
   * Optional persistence store for exhausted notifications (issue #460).
   * When provided, a notification that exceeds `maxAttempts` is written here
   * instead of being silently discarded.
   */
  store?: NotificationStore;
}

// ---------------------------------------------------------------------------
// Delivery helpers
// ---------------------------------------------------------------------------

function decisionLabel(decision: boolean): string {
  return decision ? "yes" : "no";
}

function buildSummary(notification: FinalizeNotification): Record<string, unknown> {
  return {
    marketId: notification.marketId,
    decision: decisionLabel(notification.decision),
    txHash: notification.txHash,
    voters: notification.councilVotes.length,
    finalizedAt: notification.finalizedAt,
    // Omitted rather than null when absent, so the payload shape is unchanged
    // for callers that do not trace.
    ...(notification.correlationId ? { correlationId: notification.correlationId } : {}),
    ...(notification.originRequestId ? { originRequestId: notification.originRequestId } : {}),
  };
}

/**
 * Attempt a single HTTP delivery. Returns `true` on success, throws on failure.
 */
async function deliverOnce(
  webhookUrl: string,
  body: string,
  notification: FinalizeNotification,
  options: Required<Pick<FinalizeNotifierOptions, "fetchFn" | "timeoutMs" | "webhookSigningSecret">>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const timestamp = Math.floor(Date.now() / 1_000);
  const signatureHeaders: Record<string, string> = {};
  if (options.webhookSigningSecret) {
    const sig = signWebhookPayload(options.webhookSigningSecret, timestamp, body);
    signatureHeaders["X-Signature"] = sig;
    signatureHeaders["X-Timestamp"] = String(timestamp);
  }

  try {
    const response = await options.fetchFn(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(notification.correlationId ? { [REQUEST_ID_HEADER]: notification.correlationId } : {}),
        ...signatureHeaders,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Delivers a finalize notification with bounded exponential-backoff retries.
 *
 * Delivery is always best-effort:
 *  - webhook failures are logged and swallowed — they must never block or
 *    roll back an already-persisted finalization (issue #460).
 *  - When all attempts are exhausted and a `store` is configured, the
 *    notification is persisted for operator replay (issue #460).
 *  - When `webhookSigningSecret` is configured, each delivery is signed with
 *    HMAC-SHA256 and the `X-Signature` / `X-Timestamp` headers are added
 *    (issue #461).
 *
 * Returns `true` when the webhook was delivered (or when there was no webhook
 * to call), `false` when all attempts failed.
 */
export async function notifyFinalized(
  notification: FinalizeNotification,
  options: FinalizeNotifierOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? (console as unknown as Logger);
  const summary = buildSummary(notification);

  // Always log — this is the audit-friendly baseline that needs no config.
  logger.info(`Market ${notification.marketId} finalized`, summary);

  if (!options.webhookUrl) {
    return true;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_RETRIES + 1;
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCap = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const webhookUrl = options.webhookUrl;
  const webhookSigningSecret = options.webhookSigningSecret ?? "";

  const body = JSON.stringify({ event: "market_finalized", ...summary });
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deliverOnce(webhookUrl, body, notification, {
        fetchFn,
        timeoutMs,
        webhookSigningSecret,
      });
      // Success.
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isLast = attempt === maxAttempts;

      if (isLast) {
        logger.warn(
          `Finalize webhook failed for market ${notification.marketId} after ${attempt} attempt(s)`,
          { ...summary, error: lastError },
        );
      } else {
        logger.warn(
          `Finalize webhook attempt ${attempt}/${maxAttempts} failed for market ${notification.marketId}, retrying`,
          { ...summary, error: lastError, attempt, maxAttempts },
        );
        // Exponential backoff with full jitter before the next attempt.
        const sleepMs = backoffMs(attempt - 1, backoffBase, backoffCap);
        await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      }
    }
  }

  // All attempts exhausted — persist to dead-letter store if configured.
  if (options.store) {
    try {
      await options.store.persistFailed(notification, lastError);
    } catch (storeErr) {
      logger.warn("failed to persist exhausted finalize notification", {
        marketId: notification.marketId,
        error: storeErr instanceof Error ? storeErr.message : String(storeErr),
      });
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// PostgreSQL-backed NotificationStore (issue #460)
// ---------------------------------------------------------------------------

/** Minimal queryable interface (mirrors indexer/src/deadLetter.ts). */
export interface NotificationQueryable {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/**
 * Creates a {@link NotificationStore} backed by the shared
 * `failed_webhook_notifications` table.  Operators can inspect or replay rows
 * from this table after a prolonged outage.
 *
 * Call `ensureFailedWebhookNotificationsTable` once at startup to create the
 * table if it does not exist.
 */
export function createPostgresNotificationStore(db: NotificationQueryable): NotificationStore {
  return {
    async persistFailed(notification, lastError) {
      try {
        await db.query(
          `INSERT INTO failed_webhook_notifications
             (market_id, payload, last_error, created_at)
           VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (market_id) DO UPDATE
             SET payload     = EXCLUDED.payload,
                 last_error  = EXCLUDED.last_error,
                 created_at  = NOW()`,
          [
            notification.marketId,
            JSON.stringify(notification),
            lastError,
          ],
        );
      } catch (err) {
        // Swallow — store errors must not surface to callers.
        void err;
      }
    },
  };
}

/**
 * DDL for the dead-letter table used by {@link createPostgresNotificationStore}.
 *
 * Run this once at startup (or in a migration) before the notifier is used.
 */
export const failedWebhookNotificationsTableSql = `
CREATE TABLE IF NOT EXISTS failed_webhook_notifications (
  id          BIGSERIAL    PRIMARY KEY,
  market_id   TEXT         NOT NULL UNIQUE,
  payload     JSONB        NOT NULL,
  last_error  TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_failed_webhook_notifications_created_at
  ON failed_webhook_notifications (created_at ASC);
`.trim();
