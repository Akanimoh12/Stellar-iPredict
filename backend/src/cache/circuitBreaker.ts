/**
 * Redis circuit breaker — issue #481.
 *
 * Wraps every Redis call site so a sustained Redis outage degrades to a
 * direct database read rather than adding a timeout to every request.
 *
 * ## State machine
 *
 *   CLOSED → (consecutive failures ≥ threshold) → OPEN
 *   OPEN   → (reset timeout elapsed)             → HALF_OPEN
 *   HALF_OPEN→ (failure)                        → OPEN
 *   HALF_OPEN→ (success × threshold)             → CLOSED
 *
 * While CLOSED, reads proceed normally. While OPEN, reads skip Redis
 * entirely and fall back to the loader. In HALF_OPEN a single request
 * is allowed through to probe recovery.
 *
 * ## Metrics
 *
 * Two Prometheus-style counters are exposed via {@link getCircuitMetrics}:
 *
 * - `cache_failures_total` — monotonic counter of every Redis error.
 * - `cache_circuit_state`  — gauge (0=closed, 1=open, 2=half-open).
 *
 * A Redis *error* is neither a hit nor a miss, and must not be folded into
 * the hit-rate ratio (issue #214).
 *
 * @see docs/ORACLE_AND_BACKEND.md §Caching Strategy
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the circuit from CLOSED to OPEN. */
  failureThreshold: number;
  /** How long (ms) the circuit stays OPEN before transitioning to HALF_OPEN. */
  resetTimeoutMs: number;
  /**
   * Successful probe calls needed in HALF_OPEN to return to CLOSED.
   * @default 1
   */
  halfOpenSuccessThreshold?: number;
}

/** Default tuning — tuned to stop adding latency quickly without false positives. */
export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 5_000,
  halfOpenSuccessThreshold: 1,
};

/**
 * Calculates the backoff delay for HALF_OPEN state based on consecutive failures.
 * More consecutive failures → longer backoff, preventing stampede when Redis recovers.
 */
export function calculateHalfOpenBackoff(
  consecutiveFailures: number,
  baseMs: number = 30_000,
  multiplier: number = 1_500,
): number {
  return Math.min(baseMs * Math.pow(multiplier, Math.min(consecutiveFailures - 1, 5)), 300_000);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half_open";

/** Numeric encoding used for the Prometheus gauge. */
const STATE_VALUE: Record<CircuitState, number> = {
  closed: 0,
  open: 1,
  half_open: 2,
};

export interface CircuitMetrics {
  state: CircuitState;
  failures: number;
  successes: number;
  consecutiveFailures: number;
    openedAt: number | null;
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

/**
 * A simple single-circuit breaker for Redis operations.
 *
 * Thread safety: Node.js is single-threaded; no locking is required.
 */
export class RedisCircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private openedAt: number | null = null;
  private halfOpenSuccesses = 0;

  constructor(private options: CircuitBreakerOptions) {}

  /** Current state of the circuit. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** `true` when the circuit is CLOSED (normal operation). */
  get isClosed(): boolean {
    return this.state === "closed";
  }

  /** `true` when the circuit is OPEN (Redis calls are skipped). */
  get isOpen(): boolean {
    return this.state === "open";
  }

  /**
   * Whether a Redis call should be attempted right now.
   *
   * In CLOSED state this is always `true`.
   * In OPEN state it becomes `true` only after the reset timeout elapses
   * (transitioning to HALF_OPEN).
   * In HALF_OPEN it returns `true` for a bounded number of probe calls.
   */
  canAttempt(): boolean {
    if (this.state === "closed") {
      return true;
    }

    if (this.state === "open") {
    const elapsed = Date.now() - (this.openedAt ?? 0);
    const backoff = calculateHalfOpenBackoff(this.failureCount, this.options.resetTimeoutMs);
    if (elapsed >= backoff) {
      this.state = "half_open";
      this.halfOpenSuccesses = 0;
      return true;
    }
    return false;
  }

    // HALF_OPEN — allow a bounded number of probe calls.
    const threshold =
      this.options.halfOpenSuccessThreshold ?? 1;
    return this.halfOpenSuccesses < threshold;
  }

  /**
   * Record a successful Redis call.
   *
   * In HALF_OPEN, enough consecutive successes close the circuit.
   * In CLOSED, this resets the consecutive-failure counter.
   */
  recordSuccess(): void {
    this.totalSuccesses++;

    if (this.state === "half_open") {
      this.halfOpenSuccesses++;
      const threshold =
        this.options.halfOpenSuccessThreshold ?? 1;
      if (this.halfOpenSuccesses >= threshold) {
        this.reset();
      }
    } else {
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed Redis call.
   *
   * In CLOSED, increments the consecutive-failure counter and opens
   * the circuit once it reaches the threshold.
   * In HALF_OPEN, re-opens the circuit immediately.
   */
  recordFailure(): void {
    this.totalFailures++;

    if (this.state === "half_open") {
      this.state = "open";
      this.openedAt = Date.now();
      this.halfOpenSuccesses = 0;
      return;
    }

    if (this.state === "closed") {
      this.failureCount++;
      if (this.failureCount >= this.options.failureThreshold) {
        this.state = "open";
        this.openedAt = Date.now();
      }
    }
  }

  /** Return to CLOSED state, resetting all counters. */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenSuccesses = 0;
  }

    /** Current metrics snapshot — used by the metrics endpoint. */
  getMetrics(): CircuitMetrics {
    return {
      state: this.state,
      failures: this.totalFailures,
      successes: this.totalSuccesses,
      consecutiveFailures: this.failureCount,
      openedAt: this.openedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

/**
 * Shared circuit breaker instance for the Redis cache layer.
 *
 * Tests can call {@link resetCircuitBreaker} to ensure a clean slate.
 */
const breaker = new RedisCircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);

/** The shared instance used by `getOrSet`, `cache.get/set/del`, etc. */
export function getCircuitBreaker(): RedisCircuitBreaker {
  return breaker;
}

/** Reset the shared circuit breaker to CLOSED state. */
export function resetCircuitBreaker(): void {
  breaker.reset();
}

/**
 * Serialise circuit-breaker metrics in Prometheus text exposition format.
 */
export function serializeCircuitMetrics(): string {
  const m = breaker.getMetrics();
  const lines = [
    "# HELP cache_failures_total Total Redis failures observed by the cache layer",
    "# TYPE cache_failures_total counter",
    `cache_failures_total ${m.failures}`,
    "",
    "# HELP cache_successes_total Total Redis calls that succeeded",
    "# TYPE cache_successes_total counter",
    `cache_successes_total ${m.successes}`,
    "",
    "# HELP cache_circuit_state Circuit breaker state (0=closed, 1=open, 2=half-open)",
    "# TYPE cache_circuit_state gauge",
    `cache_circuit_state ${STATE_VALUE[m.state]}`,
    "",
    "# HELP cache_circuit_consecutive_failures Consecutive failures since last success",
    "# TYPE cache_circuit_consecutive_failures gauge",
    `cache_circuit_consecutive_failures ${m.consecutiveFailures}`,
  ];

  return lines.join("\n") + "\n";
}
