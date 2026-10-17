import type { Queryable } from "./db.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "./types.js";
import { writeEventToDb } from "./event-router.js";

export interface DeadLetterInput {
  ledger: number;
  txHash: string;
  rawEvent: unknown;
  error: unknown;
}

/**
 * A row returned by listUnresolvedDeadLetterEvents.
 */
export interface DeadLetterRow {
  id: number;
  ledger_seq: number;
  tx_hash: string;
  raw_event: unknown;
  error_message: string;
  attempt_count: number;
  last_error: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

/**
 * Result of a single reprocess attempt.
 */
export interface ReprocessResult {
  id: number;
  resolved: boolean;
  /** Attempt number (1-based) for this run. */
  attempt: number;
  error?: string;
}

/**
 * Summary returned by reprocessDeadLetterBatch.
 */
export interface ReprocessBatchSummary {
  total: number;
  resolved: number;
  failed: number;
}

/**
 * Retention for `dead_letter_events` (issue #646). Operational, not audit:
 * a decode failure exists to debug the indexer. Once a fix has shipped and
 * this window has passed there is nothing left to learn from the row.
 * The canonical policy lives in `data_retention_policies` / docs/DATA-RETENTION.md;
 * this constant keeps the indexer's own sweep in sync with it.
 */
export const DEAD_LETTER_RETENTION_DAYS = 90;

/**
 * Queue depth above which monitoring should alert (issue #496).
 * Evaluated by refreshDeadLetterQueueDepth and exposed via metrics.
 */
export const DEAD_LETTER_ALERT_THRESHOLD = 100;

export async function persistDeadLetterEvent(db: Queryable, input: DeadLetterInput): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await db.query(
    `INSERT INTO dead_letter_events (ledger_seq, tx_hash, raw_event, error_message, created_at)
     VALUES ($1, $2, $3::jsonb, $4, NOW())`,
    [input.ledger, input.txHash, JSON.stringify(input.rawEvent), message]
  );
}

/**
 * Fetch unresolved dead-letter rows ordered oldest-first, up to `limit`.
 * Only rows with resolved_at IS NULL are returned (the active queue).
 */
export async function listUnresolvedDeadLetterEvents(
  db: Queryable,
  limit = 500,
): Promise<DeadLetterRow[]> {
  const result = await db.query<DeadLetterRow>(
    `SELECT id, ledger_seq, tx_hash, raw_event, error_message,
            attempt_count, last_error, resolved_at, created_at
     FROM dead_letter_events
     WHERE resolved_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * Count unresolved dead-letter events. Used to drive the queue-depth gauge.
 */
export async function countUnresolvedDeadLetterEvents(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM dead_letter_events WHERE resolved_at IS NULL`,
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Atomically increment attempt_count and record last_error for a single row.
 * Called before a replay attempt so attempt_count always reflects tries,
 * not successes.
 *
 * Returns the new attempt_count value.
 */
async function recordAttempt(db: Queryable, id: number, error: string): Promise<number> {
  const result = await db.query<{ attempt_count: number }>(
    `UPDATE dead_letter_events
     SET attempt_count = attempt_count + 1,
         last_error    = $2
     WHERE id = $1
     RETURNING attempt_count`,
    [id, error],
  );
  return result.rows[0]?.attempt_count ?? 1;
}

/**
 * Mark a dead-letter row as resolved (successfully replayed).
 * Idempotent — safe to call if already resolved.
 */
async function markResolved(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE dead_letter_events
     SET resolved_at = NOW()
     WHERE id = $1 AND resolved_at IS NULL`,
    [id],
  );
}

/**
 * Reconstruct a DecodedContractEvent from a dead-letter row's raw_event JSONB.
 *
 * The raw_event was stored by persistDeadLetterEvent as the original RawEvent
 * object (e.g. {ledger, txHash, topics, data, eventIndex}).  If the stored
 * JSON does not contain decoded topics/data (older rows only have ledger +
 * txHash + opaque chain data) this will surface as a replay failure with a
 * clear error, which is preferable to silent data loss.
 */
function reconstructEvent(row: DeadLetterRow): DecodedContractEvent {
  const raw = row.raw_event as Record<string, unknown>;

  const topics = Array.isArray(raw.topics) ? (raw.topics as unknown[]) : [];
  const data = raw.data !== undefined ? raw.data : raw;
  const ledger =
    typeof raw.ledger === "number"
      ? raw.ledger
      : row.ledger_seq;
  const txHash =
    typeof raw.txHash === "string"
      ? raw.txHash
      : typeof raw.tx_hash === "string"
        ? raw.tx_hash
        : row.tx_hash;
  const eventIndex =
    typeof raw.eventIndex === "number" || typeof raw.eventIndex === "bigint"
      ? (raw.eventIndex as number | bigint)
      : undefined;

  return { topics, data, ledger, txHash, eventIndex };
}

/**
 * Replay a single dead-letter event through the normal handler path.
 *
 * Idempotency is guaranteed by the ON CONFLICT (tx_hash, event_index) DO
 * NOTHING constraint in insertProcessedEvent (migration 0007).  A replay of
 * an event whose effects already landed is a no-op at the database level.
 *
 * Attempt tracking:
 *   - attempt_count is incremented before the replay so it counts tries.
 *   - On failure, last_error is updated to the new message.
 *   - On success, resolved_at is set to NOW().
 */
export async function reprocessDeadLetterEvent(
  db: DbClient,
  redis: RedisClient,
  row: DeadLetterRow,
): Promise<ReprocessResult> {
  let event: DecodedContractEvent;
  try {
    event = reconstructEvent(row);
  } catch (decodeErr) {
    const msg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
    const attempt = await recordAttempt(db as unknown as Queryable, row.id, msg);
    return { id: row.id, resolved: false, attempt, error: msg };
  }

  const errorMsg =
    `pre-attempt placeholder for row ${row.id} (attempt ${row.attempt_count + 1})`;
  // Record the attempt before trying so the counter is always accurate even if
  // the process is killed mid-flight.
  const attempt = await recordAttempt(db as unknown as Queryable, row.id, errorMsg);

  try {
    await writeEventToDb(event, db, redis);
    await markResolved(db as unknown as Queryable, row.id);
    return { id: row.id, resolved: true, attempt };
  } catch (replayErr) {
    const msg = replayErr instanceof Error ? replayErr.message : String(replayErr);
    // Overwrite the placeholder with the real error from this attempt.
    await (db as unknown as Queryable).query(
      `UPDATE dead_letter_events SET last_error = $2 WHERE id = $1`,
      [row.id, msg],
    );
    return { id: row.id, resolved: false, attempt, error: msg };
  }
}

/**
 * Reprocess a batch of unresolved dead-letter events.
 *
 * Iterates through every unresolved row (up to `batchSize`), replays each
 * through the normal handler path, marks successes resolved, and updates
 * attempt counts on failures.  Returns a summary suitable for logging/alerting.
 *
 * This function is called by the reprocess CLI command (reprocess.ts) and can
 * also be run on a schedule as a maintenance job.
 */
export async function reprocessDeadLetterBatch(
  db: DbClient,
  redis: RedisClient,
  opts: { batchSize?: number } = {},
): Promise<ReprocessBatchSummary> {
  const batchSize = opts.batchSize ?? 500;
  const rows = await listUnresolvedDeadLetterEvents(db as unknown as Queryable, batchSize);

  let resolved = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await reprocessDeadLetterEvent(db, redis, row);
    if (result.resolved) {
      resolved++;
    } else {
      failed++;
    }
  }

  return { total: rows.length, resolved, failed };
}

/**
 * Delete dead-letter rows older than the retention window, in one bounded
 * batch. Returns the number removed. Call repeatedly until it returns 0 to
 * drain a large backlog without a long-held lock. Safe to run concurrently
 * with the SQL-side `purge_dead_letter_events()` — both are idempotent.
 */
export async function purgeDeadLetterEvents(
  db: Queryable,
  opts: { olderThanDays?: number; batchSize?: number } = {}
): Promise<number> {
  const olderThanDays = opts.olderThanDays ?? DEAD_LETTER_RETENTION_DAYS;
  const batchSize = opts.batchSize ?? 5000;
  const result = await db.query(
    `WITH doomed AS (
       SELECT id FROM dead_letter_events
       WHERE created_at < NOW() - ($1 || ' days')::interval
       ORDER BY created_at ASC
       LIMIT $2
     )
     DELETE FROM dead_letter_events WHERE id IN (SELECT id FROM doomed)`,
    [olderThanDays, batchSize]
  );
  return result.rowCount ?? 0;
}
