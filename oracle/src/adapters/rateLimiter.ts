export interface ProviderRateLimit {
  limit: number;
  windowMs: number;
}

export interface ProviderRateLimiterOptions {
  defaultLimit?: number;
  defaultWindowMs?: number;
  providers?: Record<string, ProviderRateLimit>;
  sleep?: (durationMs: number) => Promise<void>;
}

interface ProviderState {
  requests: number[];
}

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Coordinates request quotas independently for each upstream provider.
 *
 * Calls are admitted using a sliding window. When a provider's budget is
 * exhausted, acquire waits until the oldest request leaves the window rather
 * than allowing callers to exceed the provider quota.
 */
export class ProviderRateLimiter {
  private readonly states = new Map<string, ProviderState>();
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  private readonly providers: Readonly<Record<string, ProviderRateLimit>>;
  private readonly sleep: (durationMs: number) => Promise<void>;

  constructor(options: ProviderRateLimiterOptions = {}) {
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.defaultWindowMs = options.defaultWindowMs ?? DEFAULT_WINDOW_MS;
    this.providers = options.providers ?? {};
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));

    if (!Number.isInteger(this.defaultLimit) || this.defaultLimit <= 0) {
      throw new Error("Provider rate-limit must be a positive integer");
    }
    if (!Number.isFinite(this.defaultWindowMs) || this.defaultWindowMs <= 0) {
      throw new Error("Provider rate-limit window must be positive");
    }

    for (const [provider, config] of Object.entries(this.providers)) {
      this.validateConfig(provider, config);
    }
  }

  /**
   * Wait until one request can be reserved for the provider.
   */
  async acquire(provider: string): Promise<void> {
    const config = this.configFor(provider);
    let state = this.states.get(provider);
    if (!state) {
      state = { requests: [] };
      this.states.set(provider, state);
    }

    for (;;) {
      const now = Date.now();
      this.prune(state, now, config.windowMs);

      if (state.requests.length < config.limit) {
        state.requests.push(now);
        return;
      }

      const oldest = state.requests[0]!;
      const waitMs = Math.max(1, oldest + config.windowMs - now);
      await this.sleep(waitMs);
    }
  }

  /**
   * Attempt to reserve one request without waiting.
   */
  tryAcquire(provider: string): boolean {
    const config = this.configFor(provider);
    let state = this.states.get(provider);
    if (!state) {
      state = { requests: [] };
      this.states.set(provider, state);
    }

    const now = Date.now();
    this.prune(state, now, config.windowMs);
    if (state.requests.length >= config.limit) return false;

    state.requests.push(now);
    return true;
  }

  /** Remove all reservations, or only those belonging to one provider. */
  reset(provider?: string): void {
    if (provider === undefined) {
      this.states.clear();
    } else {
      this.states.delete(provider);
    }
  }

  /** Number of currently tracked providers. */
  get size(): number {
    return this.states.size;
  }

  private configFor(provider: string): ProviderRateLimit {
    const config = this.providers[provider];
    if (config) return config;
    return { limit: this.defaultLimit, windowMs: this.defaultWindowMs };
  }

  private validateConfig(provider: string, config: ProviderRateLimit): void {
    if (!Number.isInteger(config.limit) || config.limit <= 0) {
      throw new Error(`Rate-limit for ${provider} must be a positive integer`);
    }
    if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
      throw new Error(`Rate-limit window for ${provider} must be positive`);
    }
  }

  private prune(state: ProviderState, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    let firstLive = 0;
    while (firstLive < state.requests.length && state.requests[firstLive]! <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) state.requests.splice(0, firstLive);
  }
}

/**
 * Binance's public API allows 1,200 request-weight units per minute. The
 * ticker-price endpoint has a weight of two, so 600 calls per minute is the
 * conservative request quota used here.
 */
export const PROVIDER_RATE_LIMITS: Readonly<Record<string, ProviderRateLimit>> = {
  binance: { limit: 600, windowMs: 60_000 },
};

/** Shared process-wide limiter used by all adapters for the same provider. */
export const sharedProviderRateLimiter = new ProviderRateLimiter({
  providers: PROVIDER_RATE_LIMITS,
});
