import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";

/**
 * Request logging with a correlation id.
 *
 * Every request gets an id that is (a) attached to each log line it produces
 * and (b) echoed back to the caller in the `x-request-id` response header, so a
 * user-reported error can be traced to the exact request in the logs.
 *
 * An inbound `x-request-id` is reused — that keeps the id stable across the
 * frontend → API hop — but only after validation, since it lands in log output.
 */

/** Header carrying the correlation id, both inbound and outbound. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Upper bound on an accepted inbound id; generated ids are 36 chars. */
export const MAX_REQUEST_ID_LENGTH = 128;

/** Conservative charset — keeps control characters out of log lines. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Headers that must never reach the logs verbatim. */
const REDACTED_HEADERS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
];

export interface RawRequestLike {
  headers: IncomingHttpHeaders;
}

/** True when `value` is safe to use as a correlation id. */
export function isValidRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

/** Reuses a valid inbound correlation id, otherwise mints a fresh one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return isValidRequestId(candidate) ? candidate : randomUUID();
}

/** Fastify `genReqId` — the id every log line for the request is tagged with. */
export function genReqId(req: RawRequestLike): string {
  return resolveRequestId(req.headers[REQUEST_ID_HEADER]);
}

export interface LoggerOptions {
  level: string;
  redact: { paths: string[]; censor: string };
}

/**
 * Logger options for the Fastify factory. Tests run silent so suites are not
 * drowned in request logs.
 */
export function createLoggerOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const level = env.NODE_ENV === "test" ? "silent" : (env.LOG_LEVEL ?? "info");

  return {
    level,
    redact: { paths: REDACTED_HEADERS, censor: "[redacted]" },
  };
}

/**
 * Emits one structured line per completed request and exposes the correlation
 * id to the caller. Pair with `disableRequestLogging: true` so this is the only
 * per-request log line rather than a duplicate of Fastify's built-in pair.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
        ip: request.ip,
      },
      "request completed"
    );
  });

  app.addHook("onError", async (request, _reply, error) => {
    request.log.error(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        err: error,
      },
      "request failed"
    );
  });
}

/**
 * Structured slow-query entry emitted by the database layer.
 *
 * Only the parameterised SQL text is logged — never the bound values, which
 * may carry user data and must not reach log aggregators.
 */
export interface SlowQueryLogEntry {
  /** Parameterised SQL text (with `$1`/`$2` placeholders, never bound values). */
  query: string;
  /** Measured duration of the query in milliseconds. */
  durationMs: number;
  /** Configured threshold in milliseconds that the query exceeded. */
  thresholdMs: number;
}

/**
 * Emit a single-line log entry for a slow database query.
 *
 * Lives here so the db layer shares the project's logging conventions without
 * depending on a Fastify request context (queries can run outside a request —
 * e.g. indexer backfills). Uses `console.warn` to guarantee exactly one line.
 */
export function logSlowQuery(entry: SlowQueryLogEntry): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "slow db query",
      durationMs: Math.round(entry.durationMs * 10) / 10,
      thresholdMs: entry.thresholdMs,
      query: entry.query,
    }),
  );
}

/**
 * Structured oracle submission audit log entry.
 *
 * Every oracle submission attempt (accepted or rejected) produces exactly one
 * audit line. Rejections carry a reason code so disputes can be investigated.
 * The API key and raw signature are never logged.
 */
export interface OracleAuditLogEntry {
  /** Correlation id from the request for tracing. */
  requestId: string;
  /** Provider address — the identity making the submission. */
  provider: string;
  /** Market id being submitted for. */
  marketId: number;
  /** Submission outcome: "accepted" or a rejection reason code. */
  outcome: "accepted" | "bad_key" | "bad_signature" | "duplicate_market" | "bad_request" | "internal_error";
  /** Optional detailed message explaining the rejection. */
  message?: string;
}

/**
 * Emit a structured audit log entry for an oracle submission attempt.
 *
 * Logs at info level for accepted submissions and warn level for rejections.
 * Never logs the API key, signature, or other secrets. Rejections are logged
 * at a level that survives production filtering so they can be investigated.
 */
export function logOracleSubmissionAttempt(entry: OracleAuditLogEntry, logger: any): void {
  const level = entry.outcome === "accepted" ? "info" : "warn";
  const logFn = logger[level] || logger.info;

  logFn(
    {
      requestId: entry.requestId,
      provider: entry.provider,
      marketId: entry.marketId,
      outcome: entry.outcome,
      ...(entry.message && { message: entry.message }),
    },
    `oracle submission ${entry.outcome}`,
  );
}
