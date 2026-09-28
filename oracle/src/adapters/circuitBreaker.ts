/**
 * Circuit Breaker for Failing Adapters (Issue #569)
 * 
 * Tracks adapter failure rates and skips consistently failing sources.
 */

interface BreakerState {
  failures: number;
  successes: number;
  isOpen: boolean;
  lastProbeTime: number;
}

const breakers = new Map<string, BreakerState>();

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
