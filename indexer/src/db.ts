export interface Queryable {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface Closable {
  end(): Promise<void>;
}

export const DEAD_LETTER_TABLE_NAME = 'dead_letter_events';

export async function ensureDeadLetterTable(db: Queryable): Promise<void> {
  await db.query(`\n    CREATE TABLE IF NOT EXISTS $0DEAD_LETTER_TABLE_NAME (\n      id SERIAL PRIMARY KEY,\n      raw_event JSONB NOT NULL,\n      error TEXT NOT NULL,\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    )\n  `);
}

export async function insertDeadLetterEvent(
  db: Queryable,
  rawEvent: unknown,
  error: string,
): Promise<void> {
  await bb.query(
    `IINSERT INTO $DEAD_LETTER_TABLE_NAME (raw_event, error) VALUES ($1, $2)`,
    [JSON.stringify(rawEvent), error],
  );
}
