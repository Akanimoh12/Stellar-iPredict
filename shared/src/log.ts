/**
 * The one logger every service uses — issue #630.
 *
 * ## Field names are the contract
 *
 * Three services used to name the same things differently (`msg` in one,
 * `message` in another, `time` or `timestamp`, numeric or string levels), so a
 * cross-service query needed per-service special cases. Every line now has the
 * same shape:
 *
 *     {"timestamp":"2026-11-21T10:00:00.000Z","level":"info","message":"...","service":"..."}
 *
 * - `timestamp` — ISO 8601, UTC.
 * - `level` — one of `debug | info | warn | error`, lower-case string.
 * - `message` — the human-readable event name.
 * - `service` — bound once per process, e.g. `backend`, `oracle-aggregator`.
 * - `requestId` — the inbound/generated HTTP request id (see {@link REQUEST_ID_HEADER}).
 * - `correlationId` — one id per oracle market-processing attempt (issue #467).
 * - `error` — a thrown value, serialised by {@link serializeError}. Application
 *   code always uses this key. Fastify's own request-failure lines still use
 *   `err` (pino's default); the backend serialises both the same way.
 *
 * Use {@link LOG_FIELDS} rather than re-typing these names.
 *
 * The backend's Fastify (pino) logger is configured to emit the same names; see
 * `backend/src/lib/log.ts`.
 */

/** The canonical field names. Exported so no service re-types them. */
export const LOG_FIELDS = {
  timestamp: "timestamp",
  level: "level",
  message: "message",
  service: "service",
  requestId: "requestId",
  correlationId: "correlationId",
  error: "error",
} as const;

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

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(value: string): value is LogLevel {
  return (LEVEL_ORDER as readonly string[]).includes(value);
}

/** Parses a level name, defaulting to `info` for anything unrecognised. */
export function parseLogLevel(value?: string | null): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized && isLogLevel(normalized) ? normalized : "info";
}

function levelIndex(level: LogLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/** Turns a thrown value into a JSON-safe object under the `error` key. */
export function serializeError(error: Error): Record<string, unknown> {
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
    Object.entries(fields).map(([key, value]) => [key, normalizeValue(value)]),
  );
}

/**
 * Creates a logger that writes one JSON object per line.
 *
 * Bindings (for example `service`) are merged into every record; per-call
 * fields win over bindings when a key collides.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = parseLogLevel(options.level);
  const sink = options.sink ?? ((line: string) => console.log(line));
  const timestamp = options.timestamp ?? (() => new Date().toISOString());
  const baseBindings = normalizeFields(options.bindings);

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (levelIndex(level) < levelIndex(minLevel)) return;

    const record: Record<string, unknown> = {
      [LOG_FIELDS.timestamp]: timestamp(),
      [LOG_FIELDS.level]: level,
      [LOG_FIELDS.message]: message,
      ...baseBindings,
      ...normalizeFields(fields),
    };

    sink(JSON.stringify(record));
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
    debug(message, fields) {
      emit("debug", message, fields);
    },
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
    error(message, fields) {
      emit("error", message, fields);
    },
    log(level, message, fields) {
      emit(level, message, fields);
    },
  };

  return logger;
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

/** Header the backend reads and echoes the request id in; the webhook sends it too. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Upper bound on an inbound request id. */
export const MAX_REQUEST_ID_LENGTH = 128;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** True when a value is safe to write into a log line and a database column. */
export function isValidRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}
