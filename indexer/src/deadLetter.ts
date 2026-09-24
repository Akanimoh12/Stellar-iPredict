import type { Queryable } from "./db.js";

export interface DeadLetterInput {
  ledger: number;
  txHash: string;
  rawEvent: unknown;
  error: unknown;
}

/**
 * Retention for `dead_letter_events` (issue #646). Operational, not audit:
 * a decode failure exists to debug the indexer. Once a fix has shipped and
 * this window has passed there is nothing left to learn from the row.
 * The canonical policy lives in `data_retention_policies` / docs/DATA-RETENTION.md;
 * this constant keeps the indexer's own sweep in sync with it.
 */
export const DEAD_LETTER_RETENTION_DAYS = 90;

export async function persistDeadLetterEvent(db: Queryable, input: DeadLetterInput): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await db.query(
    `INSERT INTO dead_letter_events (ledger_seq, tx_hash, raw_event, error_message, created_at)
     VALUES ($1, $2, $3::jsonb, $4, NOW())`,
    [input.ledger, input.txHash, JSON.stringify(input.rawEvent), message]
  );
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

export const deadLetterTableSql = `CREATE TABLE IF NOT EXISTS dead_letter_events (
  id BIGSERIAL PRIMARY KEY,
  ledger_seq BIGINT NOT NULL,
  tx_hash CHAR(64) NOT NULL,
  raw_event JSONB NOT NULL,
  error_message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_ledger ON dead_letter_events(ledger_seq DESC);
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_created_at ON dead_letter_events(created_at ASC);`;