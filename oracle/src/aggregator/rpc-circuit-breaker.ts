/**
 * The oracle's view of the shared Soroban RPC circuit breaker — issue #637.
 *
 * The state machine itself lives in `@ipredict/shared`, so the indexer and
 * oracle cannot drift on thresholds or recovery behaviour. This module only
 * owns the oracle's wiring: alert delivery, logging and metrics.
 */

import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
  type CircuitBreakerState,
} from "@ipredict/shared";
import { alertCircuitBreakerOpen } from "./alert.js";
import type { Logger } from "../log.js";

let alertWebhookUrl: string | undefined;
let logger: Logger | undefined;
let onStateChange: ((state: CircuitBreakerState, snapshot: CircuitBreakerSnapshot) => void) | undefined;
let onReject: (() => void) | undefined;

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function emitState(state: CircuitBreakerState, snapshot: CircuitBreakerSnapshot): void {
  onStateChange?.(state, snapshot);
}

/** One breaker for on-chain submissions and RPC reads in the aggregator. */
export const sorobanRpcCircuitBreaker: CircuitBreaker = createCircuitBreaker({
  name: "oracle-soroban-rpc",
  failureThreshold: positiveEnv("RPC_CIRCUIT_FAILURE_THRESHOLD", 3),
  resetTimeoutMs: positiveEnv("RPC_CIRCUIT_RESET_TIMEOUT_MS", 30_000),
  halfOpenSuccesses: positiveEnv("RPC_CIRCUIT_HALF_OPEN_SUCCESSES", 1),
  onOpen: (snapshot) => {
    emitState("open", snapshot);
    logger?.warn("Soroban RPC circuit breaker opened; submissions will fail fast", {
      breaker: snapshot.name,
      failures: snapshot.failures,
    });
    alertCircuitBreakerOpen("soroban-rpc", 1, alertWebhookUrl, logger);
  },
  onHalfOpen: (snapshot) => {
    emitState("half-open", snapshot);
    logger?.info("Soroban RPC circuit breaker probing recovery", { breaker: snapshot.name });
  },
  onClose: (snapshot) => {
    emitState("closed", snapshot);
    logger?.info("Soroban RPC circuit breaker closed", { breaker: snapshot.name });
  },
});

export interface ConfigureSorobanRpcCircuitBreakerOptions {
  logger?: Logger;
  alertWebhookUrl?: string;
  onStateChange?: (state: CircuitBreakerState, snapshot: CircuitBreakerSnapshot) => void;
  onReject?: () => void;
}

/** Supplies service-level alert routing after config has been parsed. */
export function configureSorobanRpcCircuitBreaker(
  options: ConfigureSorobanRpcCircuitBreakerOptions,
): void {
  if (options.logger) logger = options.logger;
  if (options.alertWebhookUrl !== undefined) alertWebhookUrl = options.alertWebhookUrl;
  if (options.onStateChange) onStateChange = options.onStateChange;
  if (options.onReject) onReject = options.onReject;
}

/** Counts a call that was rejected without reaching the RPC endpoint. */
export function reportSorobanRpcCircuitRejection(): void {
  onReject?.();
}

/** Test-only helper: clears the singleton trend between scenarios. */
export function resetSorobanRpcCircuitBreaker(): void {
  sorobanRpcCircuitBreaker.reset();
}
