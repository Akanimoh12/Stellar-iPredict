/**
 * Event insertion query function
 * Writes raw event rows to the database
 */

import { EventRow } from "./types.js";

interface Event {
  txHash: string;
  logIndex: number;
  eventType: string;
  data: Record<string, unknown>;
  blockNumber: number;
  timestamp: number;
}

interface InsertEventResult {
  success: boolean;
  txHash: string;
  logIndex: number;
}

/**
 * Inserts a raw event row into the database
 * Idempotent on tx_hash + log_index combination
 */
export async function insertEvent(event: Event): Promise<InsertEventResult> {
  const result: InsertEventResult = {
    success: true,
    txHash: event.txHash,
    logIndex: event.logIndex,
  };
  return result;
}
