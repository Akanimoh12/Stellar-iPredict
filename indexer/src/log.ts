export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  level: LogLevel;
  child(fields: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: string;
  sink?: (line: string) => void;
  timestamp?: () => string;
  bindings?: LogFields;
}

export interface IterationSummary {
  eventsProcessed: number;
  lagLedgers: number;
  durationMs: number;
  lastLedgerSeq: number | null;
  checkpointLedger?: number;
}

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(value: string): value is LogLevel {
  return (LEVEL_ORDER as readonly string[]).includes(value);
}

export function parseLogLevel(value?: string | null): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized && isLogLevel(normalized) ? normalized : "info";
}

function levelIndex(level: LogLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([key, item]) => [key, normalizeValue(item)]));
  }
  return value;
}

function normalizeFields(fields?: LogFields): LogFields {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, normalizeValue(value)])
  );
}

function stringifyRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = parseLogLevel(options.level);
  const sink = options.sink ?? console.log;
  const timestamp = options.timestamp ?? (() => new Date().toISOString());
  const baseBindings = normalizeFields(options.bindings);

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (levelIndex(level) < levelIndex(minLevel)) return;

    const record: Record<string, unknown> = {
      timestamp: timestamp(),
      level,
      message,
      ...baseBindings,
      ...normalizeFields(fields),
    };

    sink(stringifyRecord(record));
  };

  const logger: Logger = {
    level: minLevel,
    child(childBindings: LogFields): Logger {
      return createLogger({
        level: minLevel,
        sink,
        timestamp,
        bindings: {
          ...baseBindings,
          ...normalizeFields(childBindings),
        },
      });
    },
    debug(message: string, fields?: LogFields): void {
      emit("debug", message, fields);
    },
    info(message: string, fields?: LogFields): void {
      emit("info", message, fields);
    },
    warn(message: string, fields?: LogFields): void {
      emit("warn", message, fields);
    },
    error(message: string, fields?: LogFields): void {
      emit("error", message, fields);
    },
    log(level: LogLevel, message: string, fields?: LogFields): void {
      emit(level, message, fields);
    },
  };

  return logger;
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
