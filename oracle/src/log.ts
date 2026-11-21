/**
 * The oracle's logger — issue #630.
 *
 * The logger itself lives in `@ipredict/shared` so every service writes the same
 * field names. This module re-exports it for existing oracle imports and keeps
 * the one oracle-specific piece: the correlation id for a market attempt.
 */
import { randomUUID } from "node:crypto";

export {
  LOG_FIELDS,
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  createLogger,
  isValidRequestId,
  parseLogLevel,
  serializeError,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
} from "@ipredict/shared";

/**
 * Correlation ids (#467).
 *
 * One id per market processing attempt, bound to every log line emitted while
 * processing it, sent with the finalize webhook, and stored on the
 * oracle_submissions row the attempt writes. The format is the backend's
 * request id convention (`genReqId` in backend/src/lib/log.ts): a random UUID,
 * with inbound values accepted only if they pass the same check. That lets one
 * search term span both services, and lets migration 0022 enforce a single
 * rule for the ids either side stores.
 */

/** A fresh correlation id for one market processing attempt. */
export function createCorrelationId(): string {
  return randomUUID();
}
