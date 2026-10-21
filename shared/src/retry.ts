/**
 * The one retry implementation used by every service — issue #641.
 *
 * ## Why this exists
 *
 * Retry logic used to live in three places, each with its own rules:
 *
 * | Was                                    | Backoff            | Jitter | Retryable                            |
 * |----------------------------------------|--------------------|--------|--------------------------------------|
 * | `indexer/src/rpc/retry.ts`             | exponential        | full   | 429, 5xx, transport; not other 4xx    |
 * | `oracle/src/adapters/httpRetry.ts`     | linear             | none   | 429, 5xx, timeout; not other 4xx      |
 * | `oracle/src/aggregator/submit-with-retry.ts` | exponential   | full   | *everything*                          |
 *
 * They disagreed on the delay curve, on whether jitter was applied at all and
 * on which failures were worth another attempt, so an incident behaved
 * differently depending on which code path was hit. The two HTTP-ish paths
 * also decided retryability by grepping error *messages* for `429`, which
 * breaks the moment a provider rewords its error text.
 *
 * This module collapses that into a single engine. What used to differ is now
 * *configuration*: {@link RetryConfig} describes the budget, the backoff curve
 * and the jitter, and the named profiles below hold the budgets each service
 * deliberately chose.
 *
 * ## Retryability is decided by type
 *
 * {@link classifyFailure} looks at the error's *type and shape* — its class,
 * its `status`/`statusCode`/`code` fields, its `retryable` flag — never at the
 * text of its message. A failure that cannot be identified is treated as a
 * transport failure and retried, which is the safe default: the alternative
 * is silently dropping a request that would have succeeded on a second try.
 *
 * Domain code that knows better can say so by extending {@link PermanentError}
 * (or by listing error names in {@link RetryConfig.permanentErrorNames}).
 *
 * ## Jitter
 *
 * Every profile uses *full* jitter: the delay is a uniform draw in
 * `[0, ceiling)` rather than the ceiling itself. Concurrent clients that fail
 * together therefore do not retry in lockstep, which is what turns a
 * rate-limited endpoint into a self-inflicted denial of service. The draw is
 * taken fresh for every attempt, never once per sequence.
 */

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * How a failure was classified for retry purposes.
 *
 * - `rate-limit` — the peer asked us to slow down (HTTP 429).
 * - `server` — the peer failed (HTTP 5xx).
 * - `network` — the request never completed (DNS, TCP, TLS, socket).
 * - `timeout` — an attempt or the whole budget ran out of time.
 * - `client` — the peer rejected the request (HTTP 4xx other than 429).
 * - `permanent` — the failure is known not to be worth retrying.
 */
export type RetryFailureKind =
  | "rate-limit"
  | "server"
  | "network"
  | "timeout"
  | "client"
  | "permanent";

/** The outcome of classifying a failure. */
export interface RetryClassification {
  /** The category the failure fell into. */
  kind: RetryFailureKind;
  /** Whether another attempt could plausibly succeed. */
  retryable: boolean;
  /** HTTP status carried by the failure, when it had one. */
  status?: number;
  /** Delay the peer asked for via `Retry-After`, in ms. */
  retryAfterMs?: number;
}

/**
 * Base class for failures that must never be retried.
 *
 * Domain errors that are permanent by nature (a ledger gap, a rejected
 * request, a validation failure) extend this so the shared classifier treats
 * them as permanent *by type* instead of by sniffing their message.
 */
export class PermanentError extends Error {
  /** Read by {@link classifyFailure}; `false` always means "do not retry". */
  readonly retryable = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentError";
  }
}

/**
 * Thrown when the retry budget is spent, or when the failure was not
 * retryable. The last underlying failure is kept in {@link RetryExhaustedError.cause}
 * so callers can inspect it without unwrapping by hand.
 */
export class RetryExhaustedError extends Error {
  constructor(
    /** Number of attempts that were made. */
    public readonly attempts: number,
    /** The failure of the last attempt. */
    public readonly cause: unknown,
  ) {
    super(`Retry budget exhausted after ${attempts} attempt(s): ${describeError(cause)}`);
    this.name = "RetryExhaustedError";
  }
}

/**
 * Thrown when an attempt or the whole retry budget ran out of time.
 *
 * `scope` distinguishes the two: an `attempt` timeout is transient and is
 * retried, a `total` timeout means the budget is gone and the call gives up.
 */
export class RetryTimeoutError extends Error {
  constructor(
    message: string,
    /** Which budget ran out. */
    public readonly scope: "attempt" | "total",
  ) {
    super(message);
    this.name = "RetryTimeoutError";
  }
}

/** Renders any thrown value as a short, log-safe description. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Peels retry wrappers off an error until the underlying failure is reached.
 *
 * A {@link RetryExhaustedError} carries the real failure in `cause`, so
 * domain code that inspects an error (for example to recognise a retention
 * boundary) has to look through the wrapper to find it.
 */
export function unwrapError(error: unknown): unknown {
  let current = error;
  // Bounded so a self-referencing `cause` chain cannot spin forever.
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof Error && current.cause !== undefined && current.cause !== null) {
      current = current.cause;
      continue;
    }
    break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Node/undici error codes that mean "the request timed out". */
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
]);

/** Error names used by the platform for timeouts. */
const TIMEOUT_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

/**
 * Best-effort extraction of an HTTP status code from heterogeneous error shapes.
 *
 * Only numbers in the HTTP range count, so a Node error `code` such as
 * `ECONNRESET` is not mistaken for a status.
 */
export function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, any>;
  const candidates = [e.status, e.statusCode, e.code, e.response?.status];
  for (const candidate of candidates) {
    const num = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof num === "number" && Number.isFinite(num) && num >= 100 && num < 600) {
      return num;
    }
  }
  return undefined;
}

/**
 * Reads the delay a peer asked for via `Retry-After`, in ms.
 *
 * Handles the shapes the services produce: a parsed `retryAfterMs` on an
 * adapter error, a `Retry-After` header on a response, and a raw
 * `retryAfter` value. The header may be delta-seconds or an HTTP date.
 */
export function getRetryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, any>;

  const direct = e.retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;

  const headers = e.response?.headers ?? e.headers;
  const raw =
    (typeof headers?.get === "function" ? headers.get("retry-after") : undefined) ??
    headers?.["retry-after"] ??
    headers?.["Retry-After"] ??
    e.retryAfter;
  if (raw == null) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));

  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);

  return undefined;
}

/** Options that influence how a failure is classified. */
export interface RetryClassifierOptions {
  /**
   * Error `name` values that must never be retried.
   *
   * Used for failures that arrive from a third party as an untyped error but
   * whose type is known by name. Prefer extending {@link PermanentError};
   * this list exists for errors that cannot be re-classified at the source.
   */
  permanentErrorNames?: readonly string[];
}

/**
 * Classifies a failure by its type, never by its message.
 *
 * The rules, in order:
 *
 * 1. {@link PermanentError} (or a listed permanent name) is permanent.
 * 2. A {@link RetryTimeoutError} is transient only when it timed out a single
 *    attempt; a total-budget timeout is not worth another attempt.
 * 3. An explicit `retryable` flag on the error wins — that is how the oracle's
 *    adapter errors express their own contract.
 * 4. Otherwise the HTTP status decides: 429 is a rate limit, 408 is a
 *    timeout, 5xx is a server failure and all of them are retryable; every
 *    other status is a client error and is not.
 * 5. A failure without a status is a transport failure and is retryable.
 */
export function classifyFailure(
  error: unknown,
  options: RetryClassifierOptions = {},
): RetryClassification {
  const status = getStatusCode(error);
  const retryAfterMs = getRetryAfterMs(error);
  const base = { status, retryAfterMs };

  if (error instanceof PermanentError) {
    return { ...base, kind: "permanent", retryable: false };
  }

  if (error instanceof RetryTimeoutError) {
    return { ...base, kind: "timeout", retryable: error.scope === "attempt" };
  }

  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (typeof name === "string" && options.permanentErrorNames?.includes(name)) {
    return { ...base, kind: "permanent", retryable: false };
  }

  const explicit = (error as { retryable?: unknown } | null | undefined)?.retryable;
  if (typeof explicit === "boolean") {
    return { ...base, kind: kindForStatus(status), retryable: explicit };
  }

  if (status !== undefined) {
    if (status === 429) return { ...base, kind: "rate-limit", retryable: true };
    if (status === 408) return { ...base, kind: "timeout", retryable: true };
    if (status >= 500) return { ...base, kind: "server", retryable: true };
    return { ...base, kind: "client", retryable: false };
  }

  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (
    (typeof code === "string" && TIMEOUT_ERROR_CODES.has(code)) ||
    (typeof name === "string" && TIMEOUT_ERROR_NAMES.has(name))
  ) {
    return { ...base, kind: "timeout", retryable: true };
  }

  return { ...base, kind: "network", retryable: true };
}

/** The category a status falls into, used when the error states its own verdict. */
function kindForStatus(status: number | undefined): RetryFailureKind {
  if (status === undefined) return "network";
  if (status === 429) return "rate-limit";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  return "client";
}

/** True when another attempt could plausibly succeed. */
export function isRetryableError(error: unknown, options: RetryClassifierOptions = {}): boolean {
  return classifyFailure(error, options).retryable;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** The shape of the delay curve between attempts. */
export type BackoffStrategy =
  /** `base * 2^attempt`, capped. The default. */
  | "exponential"
  /** `base * (attempt + 1)`, capped. */
  | "linear"
  /** `base`, capped. */
  | "fixed";

/** How randomness is applied to the computed delay. */
export type JitterStrategy =
  /** No randomness: every client retries in lockstep. */
  | "none"
  /** Uniform draw in `[0, delay)`. The default. */
  | "full"
  /** Uniform draw in `[delay / 2, delay)`. */
  | "equal";

/** How a peer-provided `Retry-After` is honoured. */
export type RetryAfterMode =
  /** Wait `min(maxDelayMs, retryAfterMs)`. */
  | "cap"
  /** Wait exactly `retryAfterMs`; give up when it does not fit the budget. */
  | "strict"
  /** Ignore `Retry-After` entirely and use the backoff curve. */
  | "ignore";

/** The knobs that shape the delay between attempts. */
export interface BackoffOptions {
  /** Shape of the delay curve. */
  backoff: BackoffStrategy;
  /** Randomness applied to the computed delay. */
  jitter: JitterStrategy;
  /** Base delay of the curve, in ms. */
  baseDelayMs: number;
  /** Upper bound on a single delay, in ms. */
  maxDelayMs: number;
}

/**
 * Full jitter: a uniform draw in `[0, ceilingMs)`.
 *
 * Kept pure and exported so tests can assert the jitter distribution stays
 * within the expected range with a seeded RNG. Full jitter spreads concurrent
 * retry bursts far better than adding a small random offset to a fixed delay.
 */
export function jitteredDelayMs(ceilingMs: number, random: () => number): number {
  return Math.floor(random() * Math.max(0, ceilingMs));
}

/**
 * The delay before attempt `attempt + 1`, in ms.
 *
 * `attempt` is 0-based: the first retry waits `baseDelayMs`, the second
 * `baseDelayMs * 2` and so on, never exceeding `maxDelayMs`.
 */
export function computeDelayMs(attempt: number, options: BackoffOptions, random: () => number): number {
  const { backoff, jitter, baseDelayMs, maxDelayMs } = options;

  let ceiling: number;
  switch (backoff) {
    case "exponential":
      ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      break;
    case "linear":
      ceiling = Math.min(maxDelayMs, baseDelayMs * (attempt + 1));
      break;
    case "fixed":
      ceiling = Math.min(maxDelayMs, baseDelayMs);
      break;
    default:
      ceiling = Math.min(maxDelayMs, baseDelayMs);
      break;
  }

  switch (jitter) {
    case "full":
      return jitteredDelayMs(ceiling, random);
    case "equal": {
      const half = Math.floor(ceiling / 2);
      return half + jitteredDelayMs(ceiling - half, random);
    }
    case "none":
    default:
      return ceiling;
  }
}

/**
 * Full-jitter exponential backoff (AWS-style): a random value in
 * `[0, min(maxDelayMs, baseDelayMs * 2^attempt))` rather than the full
 * exponential value, so retries from concurrent failures don't line up and
 * hammer the endpoint at the same instant.
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  return computeDelayMs(
    attempt,
    { backoff: "exponential", jitter: "full", baseDelayMs, maxDelayMs },
    random,
  );
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Everything that describes how a call is retried. */
export interface RetryConfig extends BackoffOptions {
  /** Number of retries after the initial attempt. */
  maxRetries: number;
  /** Per-attempt timeout in ms. Unset means "no per-attempt limit". */
  attemptTimeoutMs?: number;
  /** Wall-clock budget across every attempt and backoff sleep, in ms. */
  totalTimeoutMs?: number;
  /** How a peer-provided `Retry-After` is honoured. */
  retryAfter: RetryAfterMode;
  /** Error `name` values that must never be retried. */
  permanentErrorNames?: readonly string[];
  /** What the call is, for error messages. */
  label: string;
}

/** Metadata handed to {@link RetryOptions.onRetry} and {@link RetryOptions.beforeRetry}. */
export interface RetryAttempt {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** The failure of that attempt. */
  error: unknown;
  /** Delay, in ms, that was waited before the next attempt. */
  delayMs: number;
}

/**
 * What the runner should do next.
 *
 * - `retry` — run the next attempt.
 * - `skip` — consume the attempt without running the operation. Used when a
 *   duplicate submission must not be sent but the sequence may continue.
 * - `stop` — end the sequence and resolve with `value`.
 */
export type RetryDecision<T = unknown> =
  | { action: "retry" }
  | { action: "skip" }
  | { action: "stop"; value?: T };

/** Everything the runner accepts. */
export interface RetryOptions<T = unknown> extends Partial<RetryConfig> {
  /**
   * Decides whether a thrown error is worth retrying. Defaults to
   * {@link classifyFailure}. Return `false` to surface the error immediately.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Invoked before each backoff sleep — useful for logging/metrics. */
  onRetry?: (info: RetryAttempt) => void;
  /**
   * Guard consulted after the backoff sleep, before the next attempt.
   *
   * Returning `stop` ends the sequence successfully, `skip` consumes the
   * attempt without running the operation, `retry` runs it.
   */
  beforeRetry?: (info: RetryAttempt) => RetryDecision<T> | Promise<RetryDecision<T>>;
  /** Injected sleep, for tests. Defaults to a `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected RNG in [0, 1), for deterministic jitter in tests. */
  random?: () => number;
  /** Injected clock, for tests. */
  now?: () => number;
  /**
   * Builds the error raised once the budget is spent. Defaults to wrapping the
   * last failure in {@link RetryExhaustedError}.
   */
  finalError?: (error: unknown, attempts: number) => Error;
  /**
   * Builds the error raised when a timeout is hit. Defaults to
   * {@link RetryTimeoutError}.
   */
  timeoutError?: (message: string, scope: "attempt" | "total") => Error;
}

/** The configuration used when a caller does not override anything. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  backoff: "exponential",
  jitter: "full",
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  retryAfter: "cap",
  label: "operation",
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drops keys whose value is `undefined` so they do not shadow the defaults. */
function definedOnly<T extends object>(source: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}

/**
 * Binds a budget to the runner.
 *
 * A service states its budget once — {@link RPC_RETRY_CONFIG},
 * {@link HTTP_RETRY_CONFIG}, {@link SUBMIT_RETRY_CONFIG} — and call sites may
 * still override individual knobs. This is how the differences between the
 * services became configuration instead of three implementations.
 */
export function createRetryRunner(defaults: RetryConfig) {
  return function runWithDefaults<T>(
    fn: (attempt: number, signal: AbortSignal) => Promise<T> | T,
    options: RetryOptions<T> = {},
  ): Promise<T> {
    return withRetry(fn, { ...defaults, ...definedOnly(options) });
  };
}

/**
 * Rejects when `ms` elapses. Racing against this guarantees the attempt ends
 * even if the injected/underlying request ignores its abort signal.
 *
 * The rejection is queued *before* `onTimeout` runs, so an operation that
 * reacts to the abort signal by rejecting cannot win the race with a vaguer
 * "aborted" error — the caller is told the attempt timed out.
 */
function timeoutRace(
  ms: number,
  make: () => Error,
  onTimeout?: () => void,
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = make();
      reject(error);
      onTimeout?.();
    }, Math.max(0, ms));
  });
  // Avoid unhandled rejection noise when the race is won by the real request.
  promise.catch(() => undefined);
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Timeout errors this runner raised with `scope: "total"`.
 *
 * A total timeout means the wall-clock budget is gone, so the sequence has to
 * stop instead of retrying. The runner recognises its own timeout errors
 * through this set rather than through their class, so a service is free to
 * raise its own error type for them.
 */
const totalTimeoutErrors = new WeakSet<object>();

/**
 * Runs `fn`, retrying transient failures with exponential backoff + full jitter.
 *
 * The backoff for attempt `n` (0-based) is `min(maxDelayMs, baseDelayMs * 2^n)`,
 * randomised with full jitter to avoid thundering-herd retries. A peer that
 * sent a `Retry-After` overrides the computed delay.
 *
 * @throws the error built by {@link RetryOptions.finalError} once the budget is
 * spent or the failure turns out not to be retryable.
 */
export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T> | T,
  options: RetryOptions<T> = {},
): Promise<T> {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...definedOnly(options) };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const isRetryable =
    options.isRetryable ??
    ((error: unknown) =>
      classifyFailure(error, { permanentErrorNames: config.permanentErrorNames }).retryable);
  const finalError =
    options.finalError ?? ((error: unknown, attempts: number) => new RetryExhaustedError(attempts, error));
  const timeoutError =
    options.timeoutError ?? ((message: string, scope: "attempt" | "total") => new RetryTimeoutError(message, scope));

  const deadline = config.totalTimeoutMs === undefined ? undefined : now() + config.totalTimeoutMs;

  /** Builds a timeout error and remembers the ones that end the sequence. */
  const makeTimeout = (message: string, scope: "attempt" | "total"): Error => {
    const error = timeoutError(message, scope);
    if (scope === "total") totalTimeoutErrors.add(error as object);
    return error;
  };

  let lastError: unknown;
  let attempts = 0;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    attempts = attempt + 1;

    if (attempt > 0) {
      const delayMs = resolveDelayMs(attempt - 1, config, lastError, random);

      // The next attempt has to fit in the remaining budget, otherwise waiting
      // would only burn the time the caller has left.
      if (deadline !== undefined && now() + delayMs >= deadline) {
        if (getRetryAfterMs(lastError) !== undefined) {
          // The peer asked for a longer pause than the budget allows. Report
          // the rate limit itself rather than a generic timeout.
          throw finalError(lastError, attempts);
        }
        throw makeTimeout(totalBudgetMessage(config), "total");
      }

      options.onRetry?.({ attempt, error: lastError, delayMs });
      await sleep(delayMs);

      if (options.beforeRetry) {
        const decision = await options.beforeRetry({ attempt, error: lastError, delayMs });
        if (decision.action === "stop") return decision.value as T;
        if (decision.action === "skip") continue;
      }
    }

    if (deadline !== undefined && now() >= deadline) {
      throw makeTimeout(totalBudgetMessage(config), "total");
    }

    try {
      return await runAttempt(fn, attempt, config, deadline, now, makeTimeout);
    } catch (error) {
      lastError = error;
      // A total-budget timeout means there is no time left for another attempt.
      if (isTotalTimeout(error)) throw error;
      if (!isRetryable(error)) break;
    }
  }

  throw finalError(lastError, attempts);
}

/** True for a timeout this runner raised because the wall-clock budget ran out. */
function isTotalTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && totalTimeoutErrors.has(error);
}

/** The delay before the next attempt, honouring a peer-provided `Retry-After`. */
function resolveDelayMs(
  attempt: number,
  config: RetryConfig,
  error: unknown,
  random: () => number,
): number {
  if (config.retryAfter !== "ignore") {
    const retryAfterMs = getRetryAfterMs(error);
    if (retryAfterMs !== undefined) {
      // A peer-provided delay is never jittered: it is a promise about when
      // the peer will accept requests again, not a guess.
      return config.retryAfter === "strict" ? retryAfterMs : Math.min(config.maxDelayMs, retryAfterMs);
    }
  }
  return computeDelayMs(attempt, config, random);
}

/** The message used when the wall-clock budget is spent. */
function totalBudgetMessage(config: RetryConfig): string {
  return `Total retry budget of ${config.totalTimeoutMs}ms exhausted for ${config.label}`;
}

/** Runs one attempt, bounded by the per-attempt timeout when one is configured. */
async function runAttempt<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T> | T,
  attempt: number,
  config: RetryConfig,
  deadline: number | undefined,
  now: () => number,
  makeTimeout: (message: string, scope: "attempt" | "total") => Error,
): Promise<T> {
  const controller = new AbortController();

  if (config.attemptTimeoutMs === undefined) {
    return await fn(attempt, controller.signal);
  }

  const remaining = deadline === undefined ? undefined : deadline - now();
  const attemptMs =
    remaining === undefined
      ? config.attemptTimeoutMs
      : Math.min(config.attemptTimeoutMs, remaining);
  // A shorter allowance than the configured timeout means the overall budget,
  // not the attempt, is what ran out.
  const cappedByTotal = remaining !== undefined && attemptMs < config.attemptTimeoutMs;

  const race = timeoutRace(
    attemptMs,
    () =>
      cappedByTotal
        ? makeTimeout(totalBudgetMessage(config), "total")
        : makeTimeout(
            `Request to ${config.label} timed out after ${config.attemptTimeoutMs}ms`,
            "attempt",
          ),
    () => controller.abort(),
  );

  try {
    const attemptWork = Promise.resolve(fn(attempt, controller.signal));
    // If the race wins, the losing work must not surface as unhandled.
    attemptWork.catch(() => undefined);
    return await Promise.race([attemptWork, race.promise]);
  } finally {
    race.cancel();
  }
}

// ---------------------------------------------------------------------------
// Profiles
//
// The budgets below are the deliberate differences between the callers. They
// are configuration of this one engine, not separate implementations.
// ---------------------------------------------------------------------------

/**
 * Soroban RPC (indexer).
 *
 * Public nodes rate-limit (~50 req/s per IP) and fail transiently, so the
 * budget is generous: five retries with a quarter-second base and full jitter
 * keeps the indexer making progress without hammering the node.
 */
export const RPC_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  backoff: "exponential",
  jitter: "full",
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  retryAfter: "cap",
  permanentErrorNames: ["LedgerGapError", "RetentionExceededError"],
  label: "RPC call",
};

/**
 * Third-party HTTP APIs (oracle data adapters).
 *
 * These warrant a tighter budget than our own RPC: the caller is waiting on
 * a provider that may be slow, and a per-attempt timeout plus an overall
 * wall-clock budget keep a hung provider from stalling the aggregator. A
 * provider's `Retry-After` is honoured exactly, and a pause that does not fit
 * the budget fails fast instead of retrying too early.
 */
export const HTTP_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoff: "exponential",
  jitter: "full",
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  retryAfter: "strict",
  label: "HTTP request",
};

/**
 * On-chain submissions (oracle aggregator).
 *
 * A submission is idempotent-guarded by an on-chain state check, so the retry
 * budget is about waiting for the network rather than about the endpoint. The
 * same shape as the RPC profile, because it talks to the same kind of node.
 */
export const SUBMIT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoff: "exponential",
  jitter: "full",
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  retryAfter: "cap",
  label: "on-chain submission",
};
