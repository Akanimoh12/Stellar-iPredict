/**
 * Shared error hierarchy — issue #633.
 *
 * Every service classifies its failures with the same three categories, so an
 * error that crosses a service boundary keeps its meaning:
 *
 * - **transient** — the same call may succeed later (network blip, rate limit,
 *   provider 5xx, "try again later"). Retry logic may retry these.
 * - **permanent** — retrying cannot change the outcome (already finalized,
 *   outcome mismatch, a provider rejected the request as malformed). Retry
 *   logic must give up immediately.
 * - **programming** — a bug: an invariant was broken or the code was called
 *   wrongly. Never retried. Retrying a bug only repeats it, and hides it
 *   behind a delay.
 *
 * Retry decisions are made from these types (see {@link classifyFailure} in
 * `retry.ts`), never from message text. Keep the message wording free to
 * change without altering behaviour.
 *
 * HTTP mapping is separate: the backend's `HttpError` keeps its status code
 * and error code. {@link classifyHttpStatus} only states which category a status
 * belongs to.
 */

/** The three retry-relevant categories. */
export type ErrorClassification = "transient" | "permanent" | "programming";

/**
 * Base class for every classified error in the services.
 *
 * `retryable` is derived from `classification`, so the two cannot disagree.
 */
export class ServiceError extends Error {
  /** Which category the failure belongs to. */
  readonly classification: ErrorClassification;
  /** Derived: true only for transient failures. */
  readonly retryable: boolean;

  constructor(
    classification: ErrorClassification,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServiceError";
    this.classification = classification;
    this.retryable = classification === "transient";
  }
}

/** A failure that may succeed if the same operation is attempted again later. */
export class TransientError extends ServiceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("transient", message, options);
    this.name = "TransientError";
  }
}

/**
 * A failure that retrying cannot fix.
 *
 * Extends the historical `PermanentError` of the retry module: `retry.ts`
 * re-exports this class, so existing `instanceof PermanentError` checks and
 * `name === "PermanentError"` keep working.
 */
export class PermanentError extends ServiceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("permanent", message, options);
    this.name = "PermanentError";
  }
}

/**
 * A bug in this code, or a broken invariant. Never retried.
 *
 * Throw this (rather than a bare `Error`) when a state is impossible by
 * construction, so a retry loop cannot mistake it for an outage.
 */
export class ProgrammingError extends ServiceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("programming", message, options);
    this.name = "ProgrammingError";
  }
}

/**
 * Category for an HTTP status.
 *
 * 408 (timeout), 425 (too early), 429 (rate limit) and 5xx are transient;
 * every other 4xx is permanent because the request itself is wrong.
 */
export function classifyHttpStatus(status: number): ErrorClassification {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return "transient";
  }
  return "permanent";
}

/**
 * True for errors that indicate a bug rather than an external failure.
 *
 * - {@link ProgrammingError} by type.
 * - `ReferenceError` and `SyntaxError` — the runtime only throws these for
 *   broken code.
 * - A `TypeError` with no `cause`. Node's `fetch` wraps network failures in a
 *   `TypeError` that *does* carry a `cause`, so a bare `TypeError` is a
 *   programming error such as reading a property of `undefined`.
 */
export function isProgrammingError(error: unknown): boolean {
  if (error instanceof ProgrammingError) return true;
  if (error instanceof ReferenceError || error instanceof SyntaxError) return true;
  if (error instanceof TypeError && (error as { cause?: unknown }).cause === undefined) {
    return true;
  }
  return false;
}

/** The category of a thrown value, when it carries one. `undefined` otherwise. */
export function getErrorClassification(error: unknown): ErrorClassification | undefined {
  if (isProgrammingError(error)) return "programming";
  if (error instanceof ServiceError) return error.classification;
  return undefined;
}
