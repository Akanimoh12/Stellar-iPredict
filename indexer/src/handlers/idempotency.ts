import type { DbClient, DecodedContractEvent } from "../types.js";
import type { DecodedEvent, Queryable } from "./types.js";

type QueryResult = {
  rowCount?: number | null;
  rows?: unknown[];
};

type IndexedEvent = {
  ledger: number | bigint;
  txHash: string;
  eventIndex?: number | bigint;
};

export interface ProcessedEventInput {
  event: IndexedEvent;
  eventType: string;
  marketId?: number | bigint | null;
  actor?: string | null;
  payload: unknown;
}

export function getEventIndex(event: DecodedContractEvent | DecodedEvent | IndexedEvent): number | bigint {
  return event.eventIndex ?? 0;
}

export async function insertProcessedEvent(
  db: DbClient | Queryable,
  input: ProcessedEventInput,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO events (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tx_hash, event_index) DO NOTHING`,
    [
      input.event.ledger,
      input.event.txHash,
      getEventIndex(input.event),
      input.eventType,
      input.marketId ?? null,
      input.actor ?? null,
      input.payload,
    ],
  ) as QueryResult | undefined;

  if (typeof result?.rowCount === "number") {
    return result.rowCount > 0;
  }

  return true;
}
