import { AdapterError, classifySourceError } from "./errors.js";
import { sanitizeProvenanceValue } from "./provenance.js";

export interface AdapterLogger {
  info?(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
  warn?(event: string, fields: Record<string, unknown>): void;
}

/** Default structured logger for adapter failures and resolution provenance. */
export const consoleAdapterLogger: AdapterLogger = {
  info(event, fields) {
    console.info(JSON.stringify({ level: "info", event, ...fields }));
  },
  error(event, fields) {
    console.error(JSON.stringify({ level: "error", event, ...fields }));
  },
  warn(event, fields) {
    console.warn(JSON.stringify({ level: "warn", event, ...fields }));
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

/**
 * Structured provenance item for a provider participating in a resolution decision.
 * Records provider, request time, raw value and threshold for each decision.
 */
export interface ResolutionProvenanceItem {
  provider: string;
  requestTime: string;
  rawValue: unknown;
  threshold?: unknown;
}

export interface ResolutionDecisionLog {
  marketId: string;
  status: string;
  outcome?: boolean;
  confidence: number;
  threshold?: unknown;
}

/**
 * Builds structured provenance items from sources consulted during a resolution.
 * Records provider, request time, raw value and threshold for each decision source.
 */
export function buildResolutionProvenance(
  sources: readonly {
    provider?: string;
    adapterId?: string;
    respondedAt?: string;
    raw?: unknown;
  }[],
  threshold?: unknown,
): ResolutionProvenanceItem[] {
  return sources.map((s) => ({
    provider: s.provider || s.adapterId || "unknown",
    requestTime: s.respondedAt || new Date().toISOString(),
    rawValue: sanitizeProvenanceValue(s.raw !== undefined ? s.raw : null),
    threshold: threshold !== undefined ? threshold : null,
  }));
}

/**
 * Emits a structured provenance log entry for every resolution decision.
 * Records provider, request time, raw value and threshold for each decision.
 */
export function logResolutionProvenance(
  decision: ResolutionDecisionLog,
  sources: readonly {
    provider?: string;
    adapterId?: string;
    respondedAt?: string;
    raw?: unknown;
  }[],
  logger: AdapterLogger = consoleAdapterLogger,
): void {
  const provenance = buildResolutionProvenance(sources, decision.threshold);
  const logFields: Record<string, unknown> = {
    marketId: decision.marketId,
    decision: {
      status: decision.status,
      outcome: decision.outcome,
      confidence: decision.confidence,
      threshold: decision.threshold,
    },
    provenance,
    recordedAt: new Date().toISOString(),
  };

  if (typeof logger.info === "function") {
    logger.info("oracle.resolution.decision", logFields);
  } else {
    logger.error("oracle.resolution.decision", logFields);
  }
}
