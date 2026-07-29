import type { Queryable } from "./db.js";

export interface DeadLetterInput {
  ledger: number;
  txHash: string;
  rawEvent: unknown;
  error: unknown;
}

export async function persistDeadLetterEvent(db: Queryable, input: DeadLetterInput): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await db.query(
    `INSERT INTO dead_letter_events (ledger_seq, tx_hash, raw_event, error_message, created_at)
     VALUES ($1, $2, $3::jsonb, $4, NOW())`,
    [input.ledger, input.txHash, JSON.stringify(input.rawEvent), message]
  );
}

export const deadLetterTableSql = `CREATE TABLE IF NOT EXISTS dead_letter_events (
  id BIGSERIAL PRIMARY KEY,
  ledger_seq BIGINT NOT NULL,
  tx_hash CHAR(64) NOT NULL,
  raw_event JSONB NOT NULL,
  error_message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_events_ledger ON dead_letter_events(ledger_seq DESC);`;
