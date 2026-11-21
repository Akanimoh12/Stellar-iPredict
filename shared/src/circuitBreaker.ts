/**
 * One circuit breaker implementation for every out-of-process dependency — #637.
 *
 * When Soroban RPC is unavailable, a retrying caller still spends its whole
 * backoff budget on every market and every poll iteration. The breaker sits in
 * front of that budget: after a small run of consecutive transient failures it
 * opens and subsequent calls fail immediately, then a single probe is allowed
 * through periodically to discover recovery.
 *
 * The mechanism lives here so the indexer and the oracle share the same state
 * machine and the same thresholds. Each service only supplies its own name and
 * alert hook; see `indexer/src/rpc/retry.ts` and
 * `oracle/src/aggregator/submit-with-retry.ts`.
 *
 * Failure classification is reused from `retry.ts`: permanent errors (a bad
 * request, a ledger gap, a programming bug) never open the breaker, because
 * they say nothing about the health of the remote service.
 */

import { classifyFailure } from "./retry.js";

export type CircuitBreakerState = "closed" | "open" | "half-open";

/** Thrown instead of running the operation while the breaker is open. */
export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly breaker: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Circuit breaker '${breaker}' is open; failing fast (retry in ${Math.ceil(retryAfterMs)}ms)`);
    this.name = "CircuitBreakerOpenError";
  }
}

/** Immutable view of a breaker, safe to log or export as a metric. */
export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitBreakerState;
  /** All transient failures seen since construction. */
  failures: number;
  /** All successful calls seen since construction. */
  successes: number;
  /** Consecutive transient failures in the current state. */
  consecutiveFailures: number;
  /** Consecutive successes in half-open state. */
  consecutiveSuccesses: number;
  openedAtMs: number | null;
  lastFailureAtMs: number | null;
  /** Calls rejected without touching the dependency while open. */
  rejectedCalls: number;
}

export interface CircuitBreakerOptions {
  /** Stable name used in logs, errors and metrics (no URLs or IDs). */
  name: string;
  /** Consecutive transient failures before opening. Default 3. */
  failureThreshold?: number;
  /** Time in open state before one probe is allowed. Default 30s. */
  resetTimeoutMs?: number;
  /** Successful probes needed to close again. Default 1. */
  halfOpenSuccesses?: number;
  /**
   * Error `name` values that represent permanent caller errors. They are
   * passed to the shared classifier so a domain error never opens the breaker.
   */
  permanentErrorNames?: readonly string[];
  /** Injected clock, for deterministic callers. */
  now?: () => number;
  /** Called once each time the breaker opens. Never throws into the caller. */
  onOpen?: (snapshot: CircuitBreakerSnapshot) => void | Promise<void>;
  /** Called when a probe is admitted. Never throws into the caller. */
  onHalfOpen?: (snapshot: CircuitBreakerSnapshot) => void | Promise<void>;
  /** Called when the breaker returns to closed. Never throws into the caller. */
  onClose?: (snapshot: CircuitBreakerSnapshot) => void | Promise<void>;
}

export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
export const DEFAULT_CIRCUIT_RESET_TIMEOUT_MS = 30_000;
export const DEFAULT_CIRCUIT_HALF_OPEN_SUCCESSES = 1;

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * A synchronous state machine with an async convenience runner.
 *
 * `allow()`/`recordSuccess()`/`recordFailure()` can be used around any call;
 * `run()` wraps the common case and guarantees outcomes are recorded exactly
 * once. All state transitions are local to the instance, so two services can
 * use separate named breakers without sharing counters.
 */
export class CircuitBreaker {
  private stateValue: CircuitBreakerState = "closed";
  private failures = 0;
  private successes = 0;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private rejectedCalls = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccesses: number;
  private readonly permanentErrorNames: readonly string[];
  private readonly now: () => number;
  private readonly onOpen?: (snapshot: CircuitBreakerSnapshot) => void | Promise<void>;
  private readonly onHalfOpen?: (snapshot: CircuitBreakerSnapshot) => void | Promise<void>;
  private readonly onClose?: (snapshot: CircuitBreakerSnapshot) => void | Promise<void>;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = positiveInt(options.failureThreshold, DEFAULT_CIRCUIT_FAILURE_THRESHOLD);
    this.resetTimeoutMs = positiveInt(options.resetTimeoutMs, DEFAULT_CIRCUIT_RESET_TIMEOUT_MS);
    this.halfOpenSuccesses = positiveInt(
      options.halfOpenSuccesses,
      DEFAULT_CIRCUIT_HALF_OPEN_SUCCESSES,
    );
    this.permanentErrorNames = options.permanentErrorNames ?? [];
    this.now = options.now ?? Date.now;
    this.onOpen = options.onOpen;
    this.onHalfOpen = options.onHalfOpen;
    this.onClose = options.onClose;
  }

  get state(): CircuitBreakerState {
    return this.stateValue;
  }

  /** True whenever the breaker is not open (including an admitted probe). */
  get isClosed(): boolean {
    return this.stateValue !== "open";
  }

  snapshot(): CircuitBreakerSnapshot {
    return Object.freeze({
      name: this.name,
      state: this.stateValue,
      failures: this.failures,
      successes: this.successes,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAtMs: this.openedAtMs,
      lastFailureAtMs: this.lastFailureAtMs,
      rejectedCalls: this.rejectedCalls,
    });
  }

  /**
   * Returns `true` when a call may be attempted. An open breaker becomes
   * half-open once the reset timeout has elapsed, admitting exactly one probe.
   * Rejected calls are counted so operators can see how much load was shed.
   */
  allow(): boolean {
    if (this.stateValue === "closed" || this.stateValue === "half-open") return true;

    const openedAt = this.openedAtMs ?? this.now();
    if (this.now() - openedAt >= this.resetTimeoutMs) {
      this.stateValue = "half-open";
      this.consecutiveSuccesses = 0;
      this.emit(this.onHalfOpen);
      return true;
    }

    this.rejectedCalls += 1;
    return false;
  }

  /** Throws {@link CircuitBreakerOpenError} unless {@link allow} succeeds. */
  assertAllowed(): void {
    if (this.allow()) return;
    const openedAt = this.openedAtMs ?? this.now();
    const remaining = Math.max(0, this.resetTimeoutMs - (this.now() - openedAt));
    throw new CircuitBreakerOpenError(this.name, remaining);
  }

  /** Records a successful dependency call, closing the breaker after enough probes. */
  recordSuccess(): void {
    this.successes += 1;
    if (this.stateValue !== "half-open") {
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses < this.halfOpenSuccesses) return;

    this.close();
  }

  /**
   * Records a failed dependency call. Only transient failures count: a
   * permanent error is a caller problem, not evidence the dependency is down.
   */
  recordFailure(error: unknown): void {
    const transient = this.isTransient(error);
    this.lastFailureAtMs = this.now();
    if (!transient) return;

    this.failures += 1;
    if (this.stateValue === "half-open") {
      // A failed probe re-opens immediately with a fresh probe window.
      this.open();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.open();
  }

  /** Runs `fn` under the breaker, failing fast while it is open. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.assertAllowed();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  /** Forgets all state — primarily for tests and operator-initiated recovery. */
  reset(): void {
    this.stateValue = "closed";
    this.failures = 0;
    this.successes = 0;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAtMs = null;
    this.lastFailureAtMs = null;
    this.rejectedCalls = 0;
  }

  private isTransient(error: unknown): boolean {
    // A failure thrown by this breaker is a control-flow signal, not a new
    // observation about the dependency.
    if (error instanceof CircuitBreakerOpenError) return false;
    return classifyFailure(error, {
      permanentErrorNames: this.permanentErrorNames,
    }).retryable;
  }

  private open(): void {
    this.stateValue = "open";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAtMs = this.now();
    // Each transition to open (including a failed recovery probe) starts a new
    // outage episode, so alerting hooks fire every time.
    this.emit(this.onOpen);
  }

  private close(): void {
    this.stateValue = "closed";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAtMs = null;
    this.emit(this.onClose);
  }

  private emit(hook: ((snapshot: CircuitBreakerSnapshot) => void | Promise<void>) | undefined): void {
    if (!hook) return;
    const snapshot = this.snapshot();
    // Alert hooks must never change the outcome of the call they observe.
    void Promise.resolve()
      .then(() => hook(snapshot))
      .catch(() => undefined);
  }
}

/** Factory for callers that prefer expressions over `new`. */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options);
}
