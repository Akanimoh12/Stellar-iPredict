import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import type {
  OracleAuthFailureByReason,
  OracleAuthFailureLevel,
  OracleAuthFailurePattern,
  OracleAuthFailureReason,
} from "./oracleAuthFailures.js";

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
export const REDACTED_HEADERS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "req.headers['x-api-key']",
  "req.headers['api-key']",
  "req.headers['x-oracle-api-key']",
  "req.headers['proxy-authorization']",
  "req.headers['x-auth-token']",
];

/**
 * Safe query parameter names that are permitted to appear in access logs.
 *
 * Any query parameter NOT in this allowlist has its value redacted to
 * `[redacted]` to prevent tokens, API keys, passwords, and sensitive data
 * from leaking into log aggregators.
 */
export const DEFAULT_ALLOWED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  // Pagination & limits
  "page",
  "limit",
  "offset",
  "cursor",
  // Filtering & search
  "filter",
  "status",
  "category",
  "sort",
  "order",
  "direction",
  "q",
  "search",
  // Time windows & dates
  "window",
  "from",
  "to",
  "since",
  "until",
]);

/**
 * Redact sensitive query parameters in a URL using an allowlist strategy.
 *
 * Any query parameter whose name (case-insensitive) is not in `allowedParams`
 * will have its value replaced with `[redacted]`.
 */
export function sanitizeUrl(
  url: string,
  allowedParams: ReadonlySet<string> = DEFAULT_ALLOWED_QUERY_PARAMS,
): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;

  const pathAndBase = url.slice(0, queryIndex);
  const remaining = url.slice(queryIndex + 1);
  if (!remaining) return pathAndBase;

  // Preserve hash fragment if present
  const hashIndex = remaining.indexOf("#");
  const search = hashIndex === -1 ? remaining : remaining.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : remaining.slice(hashIndex);

  const params = search.split("&");
  const sanitizedParams = params.map((param) => {
    if (!param) return param;
    const eqIdx = param.indexOf("=");
    const rawKey = eqIdx === -1 ? param : param.slice(0, eqIdx);
    const key = decodeURIComponent(rawKey).toLowerCase();

    if (allowedParams.has(key)) {
      return param;
    }

    return `${rawKey}=[redacted]`;
  });

  return `${pathAndBase}?${sanitizedParams.join("&")}${hash}`;
}

/** Resolves the route pattern template, falling back to the path for unmatched routes. */
export function resolveRoutePattern(request: {
  routeOptions?: { url?: string };
  url: string;
}): string {
  if (request.routeOptions?.url) {
    return request.routeOptions.url;
  }
  const [path] = request.url.split("?");
  return path || "unmatched";
}

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

export interface RequestLoggingOptions {
  allowedQueryParams?: ReadonlySet<string>;
}

/** Symbol used to attach measured payload size to Fastify Reply */
const PAYLOAD_SIZE_KEY = Symbol("payloadSize");

/**
 * Emits one structured line per completed request and exposes the correlation
 * id to the caller. Pair with `disableRequestLogging: true` so this is the only
 * per-request log line rather than a duplicate of Fastify's built-in pair.
 *
 * Each line carries latency (responseTimeMs), response payload size (responseSize),
 * status code, route pattern, sanitized URL (with non-allowlisted query params
 * redacted), and the correlation request ID.
 */
export function registerRequestLogging(
  app: FastifyInstance,
  options: RequestLoggingOptions = {},
): void {
  const allowedQueryParams = options.allowedQueryParams ?? DEFAULT_ALLOWED_QUERY_PARAMS;

  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    let size = 0;
    if (typeof payload === "string") {
      size = Buffer.byteLength(payload);
    } else if (Buffer.isBuffer(payload)) {
      size = payload.length;
    }
    (reply as unknown as Record<symbol, number>)[PAYLOAD_SIZE_KEY] = size;
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const rawCl = reply.getHeader("content-length");
    const parsedCl =
      typeof rawCl === "number"
        ? rawCl
        : typeof rawCl === "string"
          ? parseInt(rawCl, 10)
          : undefined;

    const payloadSize = (reply as unknown as Record<symbol, number | undefined>)[PAYLOAD_SIZE_KEY];
    const responseSize =
      typeof payloadSize === "number"
        ? payloadSize
        : typeof parsedCl === "number" && !isNaN(parsedCl)
          ? parsedCl
          : 0;

    const routePattern = resolveRoutePattern(request);
    const sanitizedUrl = sanitizeUrl(request.url, allowedQueryParams);

    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: sanitizedUrl,
        route: routePattern,
        routePattern,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime || 0),
        responseSize: Math.max(0, responseSize),
        ip: request.ip,
      },
      "request completed",
    );
  });

  app.addHook("onError", async (request, _reply, error) => {
    request.log.error(
      {
        requestId: request.id,
        method: request.method,
        url: sanitizeUrl(request.url, allowedQueryParams),
        err: error,
      },
      "request failed",
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

  // `.call(logger, …)` rather than an extracted reference: pino reads its
  // message prefix off `this`, so `const fn = logger.warn; fn(…)` throws when
  // handed a real Fastify request logger (it only happened to work against the
  // test doubles, which bind nothing).
  logFn.call(
    logger,
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

/**
 * How the presented credential arrived, when one arrived at all.
 *
 * Recorded instead of the credential so a rejected request is still
 * diagnosable: a provider that suddenly starts sending `API-Key x` where the
 * integration used to send `Bearer x` looks the same as a wrong key until the
 * scheme is in the log. `raw` means a bare token in either accepted header.
 */
export type OracleAuthScheme = "bearer" | "api-key" | "raw" | "none";

/**
 * Structured authentication-failure entry for the oracle endpoint (#576).
 *
 * Contains only what is needed to locate the source and explain the refusal.
 * There is deliberately no field for the attempted key — a near-miss key in a
 * log line is a credential in a log line, so the value must never reach here.
 */
export interface OracleAuthFailureLogEntry {
  /** Correlation id for joining against the request log. */
  requestId: string;
  /** Closed-set reason code. */
  reason: OracleAuthFailureReason;
  /** Client address the request came from. Never credential material. */
  source?: string;
  /** Provider the request claimed, when it was established. */
  provider?: string;
  /** Which auth header carried (or failed to carry) a credential. */
  scheme?: OracleAuthScheme;
  /** Optional human-readable context; must never contain key material. */
  message?: string;
}

/**
 * Emit one structured warn line for a refused oracle request.
 *
 * Never logs the attempted key, signature, or any value derived from them.
 * The source address and reason are sufficient to answer "who, and why" without
 * turning the log aggregator into a credential store.
 */
export function logOracleAuthFailure(entry: OracleAuthFailureLogEntry, logger: any): void {
  const logFn = logger.warn || logger.info;

  logFn.call(
    logger,
    {
      requestId: entry.requestId,
      reason: entry.reason,
      ...(entry.source !== undefined && { source: entry.source }),
      ...(entry.provider !== undefined && { provider: entry.provider }),
      ...(entry.scheme !== undefined && { scheme: entry.scheme }),
      ...(entry.message !== undefined && { message: entry.message }),
    },
    `oracle auth failure ${entry.reason}`,
  );
}

/**
 * Structured entry describing a *spike*, emitted when the rolling failure
 * count crosses the baseline (see `oracleAuthFailures.ts`).
 *
 * This is the line an on-call engineer greps for. It carries the classification
 * (`misconfigured_provider` vs `distributed_guessing`) and the evidence behind
 * it, so the first question — "is one provider broken or are we being probed?"
 * — is answered by the log line itself.
 */
export interface OracleAuthFailureSpikeLogEntry {
  /** Correlation id of the failure that crossed the threshold, when in a request. */
  requestId?: string;
  level: Exclude<OracleAuthFailureLevel, "ok">;
  pattern: OracleAuthFailurePattern;
  windowFailures: number;
  distinctSources: number;
  topSource?: string;
  byReason: OracleAuthFailureByReason;
}

/**
 * Emit the spike alert line. `distributed_guessing` logs at error level so it
 * survives production log filtering; a misconfiguration logs at warn.
 */
export function logOracleAuthFailureSpike(
  entry: OracleAuthFailureSpikeLogEntry,
  logger: any,
): void {
  const logFn =
    (entry.level === "critical" ? logger.error : logger.warn) || logger.warn;

  logFn.call(
    logger,
    {
      ...(entry.requestId !== undefined && { requestId: entry.requestId }),
      level: entry.level,
      pattern: entry.pattern,
      windowFailures: entry.windowFailures,
      distinctSources: entry.distinctSources,
      ...(entry.topSource !== undefined && { topSource: entry.topSource }),
      byReason: entry.byReason,
    },
    `oracle auth failure spike: ${entry.pattern}`,
  );
}
