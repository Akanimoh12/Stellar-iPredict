import { Pool } from "pg";

export interface Queryable {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface Closable {
  end(): Promise<void>;
}

export const DEAD_LETTER_TABLE_NAME = 'dead_letter_events';

/**
 * Shared pg connection pool for standalone indexer jobs (historical backfill,
 * leaderboard rebuild). Created lazily from DATABASE_URL; the pool only opens
 * connections when a query is issued.
 */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function ensureDeadLetterTable(db: Queryable): Promise<void> {
  await db.query(`\n    CREATE TABLE IF NOT EXISTS ${DEAD_LETTER_TABLE_NAME} (\n      id SERIAL PRIMARY KEY,\n      raw_event JSONB NOT NULL,\n      error TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    )\n  `);
}

export async function insertDeadLetterEvent(
  db: Queryable,
  rawEvent: unknown,
  error: string,
): Promise<void> {
  await db.query(
    `INSERT INTO ${DEAD_LETTER_TABLE_NAME} (raw_event, error) VALUES ($1, $2)`,
    [JSON.stringify(rawEvent), error],
  );
}

export const CHECKPOINT_TABLE_NAME = "checkpoints";
export const CHECKPOINT_ID = 0;

export async function ensureCheckpointTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE_NAME} (
      id INT PRIMARY KEY,
      last_ledger_seq BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getCheckpointLedger(db: Queryable): Promise<number | null> {
  const result = await db.query<{ last_ledger_seq: number | string }>(
    `SELECT last_ledger_seq FROM ${CHECKPOINT_TABLE_NAME} WHERE id = $1`,
    [CHECKPOINT_ID],
  );
  const row = result.rows?.[0];
  if (!row || row.last_ledger_seq === null || row.last_ledger_seq === undefined) {
    return null;
  }
  return Number(row.last_ledger_seq);
}

export async function saveCheckpointLedger(db: Queryable, ledger: number): Promise<void> {
  await db.query(
    `INSERT INTO ${CHECKPOINT_TABLE_NAME} (id, last_ledger_seq, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE
     SET last_ledger_seq = EXCLUDED.last_ledger_seq,
         updated_at = NOW()`,
    [CHECKPOINT_ID, ledger],
  );
}

/**
 * Execute an arbitrary asynchronous operation within a database transaction.
 * If the operation throws, the transaction is automatically rolled back.
 * If it succeeds, the transaction is committed.
 */
export async function withTransaction<T>(
  db: Pool | { connect: () => Promise<any> },
  action: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (typeof client.release === "function") {
      client.release();
    }
  }
}

/**
 * Persists event effects and advances the checkpoint ledger atomically.
 * This guarantees that mid-batch crashes never advance the cursor past uncommitted effects,
 * ensuring at-least-once delivery with idempotent reprocessing.
 */
export async function processEventsWithCheckpointAtomic<E>(
  client: Queryable,
  events: E[],
  checkpointLedger: number,
  processEventFn: (event: E, db: Queryable) => Promise<void>,
): Promise<void> {
  for (const event of events) {
    await processEventFn(event, client);
  }
  await saveCheckpointLedger(client, checkpointLedger);
}

