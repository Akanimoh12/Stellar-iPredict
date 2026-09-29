import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { AdapterResponseCache, marketCacheKey } from "./responseCache.js";
import { type AdapterOutcome, type DataAdapter, isCryptoMarketParams, type Market } from "./index.js";
import { ProviderRateLimiter, sharedProviderRateLimiter } from "./rateLimiter.js";
import { probeHttp } from "./health.js";
import { normalizeCryptoQuote } from "./normalize.js";
import {
  assessQuote,
  extractTimestampMs,
  freshnessPolicyFromEnv,
  StaleQuoteError,
  type FreshnessPolicy,
} from "./freshness.js";
import { recordQuoteStatus } from "./stalenessRegistry.js";

/**
 * `/api/v3/ticker/price` is the obvious endpoint and the wrong one: its
 * response is `{ symbol, price }` and nothing else, so a quote frozen in an
 * edge cache is indistinguishable from a live one. `/api/v3/ticker/24hr`
 * carries the same rolling-window price as `lastPrice` plus `closeTime` — the
 * moment the window the price belongs to was closed — so the oracle can
 * measure how old the number actually is.
 */
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr";

/** `closeTime` is the authoritative stamp; the rest are fallbacks. */
const TIMESTAMP_KEYS = ["closeTime", "openTime"] as const;

interface BinanceTickerResponse {
  symbol: string;
  lastPrice: string;
  /** Epoch milliseconds the 24h rolling window closed. */
  closeTime?: number;
  openTime?: number;
}

export interface BinanceAdapterOptions extends FetchWithRetryOptions {
  rateLimiter?: ProviderRateLimiter;
  /** Overrides for the freshness bounds applied to each quote. */
  freshness?: Partial<FreshnessPolicy>;
  /** Environment the freshness bounds are read from. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolves crypto markets from Binance's public 24h ticker endpoint.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 *
 * Freshness (issue #744): every quote is timestamped by the provider, so a
 * quote older than the hard bound is rejected outright and one inside the
 * soft band is downweighted. Bounds are per-adapter and configurable — see
 * {@link freshnessPolicyFromEnv}.
 */
export class BinanceAdapter implements DataAdapter {
  readonly id = "binance";
  private readonly responseCache: AdapterResponseCache<AdapterOutcome>;

  private readonly fetchOptions: FetchWithRetryOptions;
  private readonly rateLimiter: ProviderRateLimiter;
  private readonly freshness: FreshnessPolicy;

  constructor(options: BinanceAdapterOptions = {}) {
    const { rateLimiter, env, freshness, ...fetchOptions } = options;
    this.fetchOptions = fetchOptions;
    this.rateLimiter = rateLimiter ?? sharedProviderRateLimiter;
    this.responseCache = new AdapterResponseCache(options.cacheTtlMs);
    this.freshness = freshnessPolicyFromEnv("ORACLE_BINANCE", env, freshness);
  }

  supports(market: Market): boolean {
    return market.category === "crypto" && isCryptoMarketParams(market.params);
  }

  checkHealth() { return probeHttp("https://api.binance.com/api/v3/ping", { method: "GET" }, this.fetchOptions); }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isCryptoMarketParams(market.params)) {
      throw new Error(`BinanceAdapter cannot resolve market ${market.id}: missing/invalid crypto params`);
    }
    const params = market.params;
    return this.responseCache.getOrSet(marketCacheKey(market), async () => {
      const { symbol, comparator, threshold } = params;
      const url = `${BINANCE_TICKER_URL}?symbol=${encodeURIComponent(symbol)}`;
      await this.rateLimiter.acquire(this.id);
      const response = await fetchWithRetry(url, { method: "GET" }, this.fetchOptions);
      const body = (await response.json()) as BinanceTickerResponse;

      // `lastPrice` is the 24h rolling-window price, the same value
      // `/ticker/price` returns for the same symbol.
      const price = Number(body.lastPrice);
      if (!Number.isFinite(price)) {
        throw new Error(`BinanceAdapter received a non-numeric price for ${symbol}: ${String(body.lastPrice)}`);
      }

      const now = Date.now();
      const observedAtMs = extractTimestampMs(body, TIMESTAMP_KEYS, now);
      const freshness = assessQuote(observedAtMs, this.freshness, now);
      recordQuoteStatus(this.id, freshness.status, now);

      if (freshness.status === "expired") {
        throw new StaleQuoteError(this.id, {
          ageMs: freshness.ageMs ?? 0,
          maxAgeMs: this.freshness.maxAgeMs,
          observedAtMs: freshness.observedAtMs,
        });
      }

      const { outcome, confidence } = normalizeCryptoQuote({
        price,
        threshold,
        comparator,
        observedAtMs,
        freshness: this.freshness,
        now,
      });

      return {
        outcome,
        confidence,
        raw: body,
        freshness: {
          status: freshness.status,
          ageMs: freshness.ageMs,
          observedAtMs: freshness.observedAtMs,
          maxAgeMs: this.freshness.maxAgeMs,
        },
      };
    });
  }
}
