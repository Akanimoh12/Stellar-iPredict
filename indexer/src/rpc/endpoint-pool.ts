import { rpc } from "@stellar/stellar-sdk";

/**
 * RPC endpoint failover pool.
 *
 * Maintains an ordered list of Soroban RPC endpoints and automatically fails
 * over to the next endpoint when the active one becomes unhealthy. Endpoints
 * that fail enter a cooldown period with exponential backoff, and the pool
 * periodically probes the primary endpoint to restore it when it recovers.
 *
 * Key features:
 * - Automatic failover on timeout, 5xx, connection errors
 * - Per-endpoint circuit breaker with exponential backoff (5s → 5min)
 * - Primary recovery probing (every 60s by default)
 * - Observability: logs every switch with reason, redacts credentials in URLs
 */

const INITIAL_COOLDOWN_MS = 5_000; // 5 seconds
const MAX_COOLDOWN_MS = 300_000; // 5 minutes
const PRIMARY_PROBE_INTERVAL_MS = 60_000; // 1 minute
const HEALTH_CHECK_TIMEOUT_MS = 5_000; // 5 seconds for health checks

export interface EndpointPoolOptions {
  endpoints: string[];
  logger?: Logger;
  primaryProbeIntervalMs?: number;
  onActiveEndpointChanged?: (index: number) => void;
}

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

interface EndpointState {
  url: string;
  failures: number;
  lastFailureTime: number | null;
  cooldownMs: number;
}

/**
 * Redacts API keys and credentials from URLs for safe logging.
 * Example: https://api.example.com?apikey=secret123 → https://api.example.com?apikey=***
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Redact common credential parameter names
    const credentialParams = ["apikey", "api_key", "token", "key", "secret", "auth"];
    for (const param of credentialParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, "***");
      }
    }
    // Redact username/password in URL
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    // If URL parsing fails, redact the entire thing to be safe
    return "***";
  }
}

export class EndpointPool {
  private readonly endpoints: EndpointState[];
  private activeIndex: number = 0;
  private readonly logger?: Logger;
  private readonly primaryProbeIntervalMs: number;
  private readonly onActiveEndpointChanged?: (index: number) => void;
  private probeTimer?: NodeJS.Timeout;

  constructor(options: EndpointPoolOptions) {
    if (options.endpoints.length === 0) {
      throw new Error("EndpointPool requires at least one endpoint");
    }

    this.endpoints = options.endpoints.map((url) => ({
      url,
      failures: 0,
      lastFailureTime: null,
      cooldownMs: INITIAL_COOLDOWN_MS,
    }));

    this.logger = options.logger;
    this.primaryProbeIntervalMs = options.primaryProbeIntervalMs ?? PRIMARY_PROBE_INTERVAL_MS;
    this.onActiveEndpointChanged = options.onActiveEndpointChanged;

    // Notify initial active endpoint
    if (this.onActiveEndpointChanged) {
      this.onActiveEndpointChanged(this.activeIndex);
    }

    // Start primary recovery probing
    this.startPrimaryProbe();
  }

  /**
   * Returns the currently active RPC endpoint URL.
   */
  getActiveEndpoint(): string {
    return this.endpoints[this.activeIndex].url;
  }

  /**
   * Returns the index of the currently active endpoint (for metrics/observability).
   */
  getActiveIndex(): number {
    return this.activeIndex;
  }

  /**
   * Executes a function with automatic failover.
   * 
   * If the function throws, the pool marks the current endpoint as failed and
   * retries with the next healthy endpoint. If all endpoints are exhausted,
   * throws the last error.
   */
  async withFailover<T>(
    fn: (server: rpc.Server, url: string) => Promise<T>
  ): Promise<T> {
    const attemptedIndices = new Set<number>();
    let lastError: Error | null = null;

    while (attemptedIndices.size < this.endpoints.length) {
      const candidateIndex = this.findNextHealthyEndpoint(attemptedIndices);
      
      if (candidateIndex === null) {
        // All endpoints are in cooldown — wait for the shortest cooldown
        await this.waitForCooldown();
        continue;
      }

      attemptedIndices.add(candidateIndex);
      const endpoint = this.endpoints[candidateIndex];
      const server = new rpc.Server(endpoint.url);

      try {
        const result = await fn(server, endpoint.url);
        
        // Success — if we switched from a previous endpoint, log it
        if (candidateIndex !== this.activeIndex) {
          this.switchToEndpoint(candidateIndex, "recovery");
        }
        
        // Reset failure count on success
        endpoint.failures = 0;
        endpoint.lastFailureTime = null;
        endpoint.cooldownMs = INITIAL_COOLDOWN_MS;

        return result;
      } catch (error) {
        lastError = error as Error;
        this.reportFailure(candidateIndex, error);
        
        // Don't retry if this was the only endpoint
        if (this.endpoints.length === 1) {
          throw error;
        }
      }
    }

    // All endpoints exhausted
    this.logger?.error(
      { error: lastError?.message },
      "All RPC endpoints failed, no healthy endpoints available"
    );
    throw lastError ?? new Error("All RPC endpoints failed");
  }

  /**
   * Reports a failure for a specific endpoint.
   */
  private reportFailure(index: number, error: unknown): void {
    const endpoint = this.endpoints[index];
    const now = Date.now();

    endpoint.failures++;
    endpoint.lastFailureTime = now;
    endpoint.cooldownMs = Math.min(
      endpoint.cooldownMs * 2,
      MAX_COOLDOWN_MS
    );

    const errorMessage = error instanceof Error ? error.message : String(error);

    this.logger?.warn(
      {
        endpoint: redactUrl(endpoint.url),
        endpointIndex: index,
        failures: endpoint.failures,
        cooldownMs: endpoint.cooldownMs,
        error: errorMessage,
      },
      "RPC endpoint failure"
    );

    // If this was the active endpoint, try to switch to another
    if (index === this.activeIndex) {
      const nextIndex = this.findNextHealthyEndpoint(new Set([index]));
      if (nextIndex !== null) {
        this.switchToEndpoint(nextIndex, errorMessage);
      }
    }
  }

  /**
   * Switches to a different endpoint and logs the change.
   */
  private switchToEndpoint(newIndex: number, reason: string): void {
    const oldUrl = this.endpoints[this.activeIndex].url;
    const newUrl = this.endpoints[newIndex].url;

    this.logger?.warn(
      {
        event: "rpc_endpoint_switched",
        from: redactUrl(oldUrl),
        to: redactUrl(newUrl),
        fromIndex: this.activeIndex,
        toIndex: newIndex,
        reason,
      },
      "RPC endpoint switched"
    );

    this.activeIndex = newIndex;
    
    // Notify metric/observer
    if (this.onActiveEndpointChanged) {
      this.onActiveEndpointChanged(newIndex);
    }
  }

  /**
   * Finds the next healthy endpoint that hasn't been attempted yet.
   * Returns null if all endpoints are either attempted or in cooldown.
   */
  private findNextHealthyEndpoint(attempted: Set<number>): number | null {
    const now = Date.now();

    for (let i = 0; i < this.endpoints.length; i++) {
      if (attempted.has(i)) {
        continue;
      }

      const endpoint = this.endpoints[i];
      
      // If never failed, it's healthy
      if (endpoint.lastFailureTime === null) {
        return i;
      }

      // Check if cooldown has expired
      const timeSinceFailure = now - endpoint.lastFailureTime;
      if (timeSinceFailure >= endpoint.cooldownMs) {
        return i;
      }
    }

    return null;
  }

  /**
   * Waits for the shortest cooldown period among all endpoints.
   */
  private async waitForCooldown(): Promise<void> {
    const now = Date.now();
    let shortestWait = MAX_COOLDOWN_MS;

    for (const endpoint of this.endpoints) {
      if (endpoint.lastFailureTime !== null) {
        const timeSinceFailure = now - endpoint.lastFailureTime;
        const remainingCooldown = endpoint.cooldownMs - timeSinceFailure;
        if (remainingCooldown > 0 && remainingCooldown < shortestWait) {
          shortestWait = remainingCooldown;
        }
      }
    }

    this.logger?.info(
      { waitMs: shortestWait },
      "All RPC endpoints in cooldown, waiting"
    );

    await new Promise((resolve) => setTimeout(resolve, shortestWait));
  }

  /**
   * Periodically probes the primary endpoint to restore it when it recovers.
   */
  private startPrimaryProbe(): void {
    // If there's only one endpoint, no need to probe
    if (this.endpoints.length === 1) {
      return;
    }

    this.probeTimer = setInterval(() => {
      void this.probePrimary();
    }, this.primaryProbeIntervalMs);
  }

  /**
   * Checks if the primary endpoint is healthy and switches back to it if so.
   */
  private async probePrimary(): Promise<void> {
    // Only probe if we're not already on the primary
    if (this.activeIndex === 0) {
      return;
    }

    const primary = this.endpoints[0];
    const server = new rpc.Server(primary.url);

    try {
      // Health check: try to get latest ledger with a short timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      await server.getLatestLedger();
      clearTimeout(timeout);

      // Primary is healthy — reset its state and switch back
      primary.failures = 0;
      primary.lastFailureTime = null;
      primary.cooldownMs = INITIAL_COOLDOWN_MS;

      this.logger?.info(
        { endpoint: redactUrl(primary.url) },
        "Primary RPC endpoint recovered"
      );

      this.switchToEndpoint(0, "primary recovered");
    } catch {
      // Primary still unhealthy, do nothing
      // (The error is already logged by reportFailure if it was the active endpoint)
    }
  }

  /**
   * Stops the background primary probe timer.
   */
  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * Checks if an endpoint's latest ledger is at least `minLedger`.
   * Returns true if the endpoint is usable, false otherwise.
   * 
   * This is used by the indexer to enforce monotonicity: only use endpoints
   * that are at least as far along as the highest processed ledger.
   */
  async isEndpointUsableForLedger(
    endpointUrl: string,
    minLedger: number
  ): Promise<boolean> {
    try {
      const server = new rpc.Server(endpointUrl);
      const { sequence } = await server.getLatestLedger();
      return sequence >= minLedger;
    } catch {
      return false;
    }
  }
}
