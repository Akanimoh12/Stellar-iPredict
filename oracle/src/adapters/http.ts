import { AdapterError, classifySourceError, classifySourceResponse } from "./errors.js";

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
