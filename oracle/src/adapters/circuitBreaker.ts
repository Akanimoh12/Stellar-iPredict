/**
 * Circuit Breaker for Failing Adapters (Issue #569)
 * 
 * Tracks adapter failure rates and skips consistently failing sources.
 *
 * State is in-memory unless a store is configured with
 * `configureCircuitBreakerPersistence`; then every change is saved and the
 * last saved state is restored on startup, so a restart does not close an
 * open breaker and immediately hammer a provider that is still failing.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BreakerState {
  failures: number;
  successes: number;
  isOpen: boolean;
  lastProbeTime: number;
}

export type BreakerSnapshot = Record<string, BreakerState>;

/** Durable storage for breaker state, keyed by adapter name. */
export interface CircuitBreakerStateStore {
  load(): BreakerSnapshot | undefined;
  save(snapshot: BreakerSnapshot): void;
}

/** Single-file JSON store for the single-process oracle. */
export class FileCircuitBreakerStateStore implements CircuitBreakerStateStore {
  constructor(private readonly filePath: string) {}

  load(): BreakerSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as BreakerSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(snapshot: BreakerSnapshot): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

const breakers = new Map<string, BreakerState>();
let stateStore: CircuitBreakerStateStore | undefined;

const CONFIG = {
  FAILURE_THRESHOLD: 0.8, // 80% failure rate
  MIN_REQUESTS: 10,       // Minimum requests before opening
  PROBE_INTERVAL_MS: 30000, // 30s between recovery probes
};

/**
 * Record adapter success
 */
export function recordSuccess(adapterName: string): void {
  const state = getState(adapterName);
  state.successes++;
  
  // Close breaker on successful probe
  if (state.isOpen) {
    state.isOpen = false;
    state.failures = 0;
    state.successes = 1;
    console.log(`[Circuit Breaker] CLOSED for ${adapterName}`);
  }
  persist();
}

/**
 * Record adapter failure
 */
export function recordFailure(adapterName: string): void {
  const state = getState(adapterName);
  state.failures++;
  
  const total = state.failures + state.successes;
  if (total >= CONFIG.MIN_REQUESTS) {
    const failureRate = state.failures / total;
    
    if (!state.isOpen && failureRate >= CONFIG.FAILURE_THRESHOLD) {
      state.isOpen = true;
      console.log(`[Circuit Breaker] OPEN for ${adapterName} (${(failureRate * 100).toFixed(1)}% failures)`);
      
      // Import dynamically to avoid circular deps
      import('../aggregator/alert.js').then(({ alertCircuitBreakerOpen }) => {
        alertCircuitBreakerOpen(adapterName, failureRate);
      });
    }
  }
  persist();
}

/**
 * Check if adapter should be skipped
 */
export function shouldSkip(adapterName: string): boolean {
  const state = getState(adapterName);
  
  if (!state.isOpen) return false;
  
  // Probe periodically to check recovery
  const now = Date.now();
  if (now - state.lastProbeTime > CONFIG.PROBE_INTERVAL_MS) {
    state.lastProbeTime = now;
    persist();
    return false; // Allow this request as a probe
  }
  
  return true;
}

function getState(adapterName: string): BreakerState {
  if (!breakers.has(adapterName)) {
    breakers.set(adapterName, {
      failures: 0,
      successes: 0,
      isOpen: false,
      lastProbeTime: Date.now(),
    });
  }
  return breakers.get(adapterName)!;
}

export function getBreakerStats() {
  return Array.from(breakers.entries()).map(([name, state]) => ({
    adapter: name,
    ...state,
  }));
}

/**
 * Persists breaker state to `store` and restores whatever it last saved,
 * replacing the current in-memory state. Pass `undefined` to go back to
 * in-memory only. Malformed entries are skipped; an unreadable store starts
 * from empty state rather than failing adapter calls.
 */
export function configureCircuitBreakerPersistence(store: CircuitBreakerStateStore | undefined): void {
  stateStore = store;
  if (!store) return;

  let snapshot: BreakerSnapshot | undefined;
  try {
    snapshot = store.load();
  } catch (error) {
    console.warn("[Circuit Breaker] failed to load persisted state", error);
  }

  breakers.clear();
  for (const [name, state] of Object.entries(snapshot ?? {})) {
    if (isBreakerState(state)) breakers.set(name, { ...state });
  }
}

function persist(): void {
  if (!stateStore) return;
  try {
    stateStore.save(Object.fromEntries(Array.from(breakers.entries(), ([name, state]) => [name, { ...state }])));
  } catch (error) {
    console.warn("[Circuit Breaker] failed to persist state", error);
  }
}

function isBreakerState(value: unknown): value is BreakerState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const isCount = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return (
    isCount(state.failures) &&
    isCount(state.successes) &&
    typeof state.isOpen === "boolean" &&
    typeof state.lastProbeTime === "number" &&
    Number.isFinite(state.lastProbeTime)
  );
}
