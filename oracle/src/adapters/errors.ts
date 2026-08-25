/** Error categories exposed by data-source adapters. */
export type AdapterErrorKind = "auth" | "quota" | "network" | "data";

export interface AdapterErrorOptions {
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * A normalized, safe-to-log error from an external data source.
 *
 * `retryable` deliberately excludes quota failures: callers must wait for the
 * supplied reset time instead of repeatedly spending the provider's allowance.
 */
export class AdapterError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    readonly source: string,
    readonly kind: AdapterErrorKind,
    message: string,
    options: AdapterErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AdapterError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = kind === "network";
  }
}

export interface SourceResponse {
  status: number;
  headers?: Headers | { get(name: string): string | null };
}

/** Classifies an HTTP response without reading or logging its body. */
export function classifySourceResponse(source: string, response: SourceResponse): AdapterError | undefined {
  if (response.status >= 200 && response.status < 300) return undefined;

  const retryAfterMs = parseRetryAfter(response.headers?.get("retry-after"));
  if (response.status === 429 || retryAfterMs !== undefined && response.status === 403) {
    return new AdapterError(source, "quota", "Data source quota exceeded", {
      status: response.status,
      retryAfterMs,
    });
  }

  if (response.status === 401 || response.status === 403) {
    return new AdapterError(source, "auth", "Data source authentication failed", { status: response.status });
  }

  if (response.status >= 500) {
    return new AdapterError(source, "network", "Data source is unavailable", { status: response.status });
  }

  return new AdapterError(source, "data", "Data source rejected the request", { status: response.status });
}

/** Classifies transport and parsing failures that do not have an HTTP response. */
export function classifySourceError(source: string, error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (error instanceof SyntaxError) {
    return new AdapterError(source, "data", "Data source returned invalid data", { cause: error });
  }

  return new AdapterError(source, "network", "Data source request failed", { cause: error });
}

function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
