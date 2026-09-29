import { AdapterError, classifySourceError } from "./errors.js";

export interface AdapterLogger {
  error(event: string, fields: Record<string, unknown>): void;
}

/** Default structured logger for adapter failures. */
export const consoleAdapterLogger: AdapterLogger = {
  error(event, fields) {
    console.error(JSON.stringify({ level: "error", event, ...fields }));
  },
};

/**
 * Logs only normalized metadata. Raw upstream response bodies, URLs, and
 * request headers are intentionally omitted because they may contain API keys.
 */
export function logAdapterError(
  source: string,
  error: unknown,
  logger: AdapterLogger = consoleAdapterLogger,
): AdapterError {
  const normalized = classifySourceError(source, error);
  logger.error("oracle.adapter.error", {
    source: normalized.source,
    category: normalized.kind,
    status: normalized.status,
    retryable: normalized.retryable,
    retryAfterMs: normalized.retryAfterMs,
  });
  return normalized;
}
