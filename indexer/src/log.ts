/**
 * The indexer's logger — issue #630.
 *
 * The logger itself lives in `@ipredict/shared` so every service writes the same
 * field names. This module re-exports it for existing indexer imports and keeps
 * the indexer-specific poll summary.
 */

export {
  LOG_FIELDS,
  createLogger,
  parseLogLevel,
  serializeError,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
} from "@ipredict/shared";
import type { Logger } from "@ipredict/shared";

export interface IterationSummary {
  eventsProcessed: number;
  lagLedgers: number;
  durationMs: number;
  lastLedgerSeq: number | null;
  checkpointLedger?: number;
}

export function logIterationSummary(logger: Logger, summary: IterationSummary): void {
  logger.info("poll summary", {
    eventsProcessed: summary.eventsProcessed,
    lagLedgers: summary.lagLedgers,
    durationMs: summary.durationMs,
    lastLedgerSeq: summary.lastLedgerSeq,
    checkpointLedger: summary.checkpointLedger ?? null,
  });
}
