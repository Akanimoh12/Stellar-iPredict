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
