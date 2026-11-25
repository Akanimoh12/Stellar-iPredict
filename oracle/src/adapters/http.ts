import { AdapterError, classifySourceError, classifySourceResponse, parseRetryAfter } from "./errors.js";

export interface AdapterFetchOptions extends RequestInit {
  /** The source name included in normalized errors and logs. */
  source: string;
}

/**
 * Fetches and decodes JSON for an adapter.
 *
 * This helper intentionally performs one request only. Retry orchestration is
 * owned by the caller so a 429 cannot trigger a quota-consuming retry loop.
 */
export async function fetchSourceJson<T>(url: string, options: AdapterFetchOptions): Promise<T> {
  const { source, ...request } = options;
  let response: Response;
  try {
    response = await fetch(url, request);
  } catch (error) {
    throw classifySourceError(source, error);
  }

  const responseError = classifySourceResponse(source, response);
  if (responseError) throw responseError;

  try {
    return await response.json() as T;
  } catch (error) {
    throw classifySourceError(source, error);
  }
}

export function isRetryableAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError && error.retryable;
}

/** Reads a response's `Retry-After` header as a delay in ms, if it sent a valid one. */
export function retryAfterFromHeaders(
  headers: { get(name: string): string | null } | undefined,
): number | undefined {
  return parseRetryAfter(headers?.get("retry-after"));
}

/**
 * Delay before retrying after `error`. A provider-supplied `Retry-After`
 * (carried as `retryAfterMs`) takes precedence over the caller's fixed
 * backoff schedule, so a rate-limited source is not retried before it said
 * it would accept requests again.
 */
export function retryDelayMs(error: unknown, fallbackMs: number): number {
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : fallbackMs;
}
