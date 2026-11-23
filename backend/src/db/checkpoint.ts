/**
 * Indexer checkpoint persistence
 * Stores the last processed ledger sequence so the indexer can resume
 * where it left off after a restart.
 *
 * Mirrors the polling loop described in docs/ORACLE_AND_BACKEND.md:
 *   let lastLedger = await getCheckpoint();
 *   while (true) {
 *     lastLedger = await indexEvents(lastLedger);
 *     await saveCheckpoint(lastLedger);
 *   }
 */

import { query } from "./pool.js";

// ── Row Shapes ──────────────────────────────────────────────────────────────

/** Row shape of the checkpoints table used by the indexer. */
export interface CheckpointRow {
  /** Singleton row identifier (always 0 for now). */
  id: number;
  /** Last successfully indexed Stellar ledger sequence. */
  last_ledger_seq: number;
  /** When the checkpoint was last written. */
  updated_at: Date;
}

/** Return shape of {@link getCheckpoint}. */
export interface Checkpoint {
  /** Last processed ledger sequence, or null if no checkpoint exists yet. */
  lastLedgerSeq: number | null;
}

const CHECKPOINT_ID = 0;

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Returns the last ledger sequence that was successfully indexed,
 * or null when no checkpoint has been saved yet (fresh database).
 */
export async function getCheckpoint(): Promise<Checkpoint> {
  const result = await query<CheckpointRow>(
    "SELECT id, last_ledger_seq, updated_at FROM checkpoints WHERE id = $1",
    [CHECKPOINT_ID],
  );

  const row = result.rows[0];
  return { lastLedgerSeq: row ? row.last_ledger_seq : null };
}

/**
 * Persists the given ledger sequence as the indexer's resume point.
 * Uses an upsert so the first write inserts the singleton row and
 * subsequent writes update it.
 */
export async function saveCheckpoint(ledger: number): Promise<void> {
  await query<CheckpointRow>(
    `INSERT INTO checkpoints (id, last_ledger_seq, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE
     SET last_ledger_seq = EXCLUDED.last_ledger_seq,
         updated_at = NOW()`,
    [CHECKPOINT_ID, ledger],
  );
}
