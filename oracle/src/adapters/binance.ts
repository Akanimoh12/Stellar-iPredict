import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { AdapterResponseCache, marketCacheKey } from "./responseCache.js";
import { type AdapterOutcome, type DataAdapter, isCryptoMarketParams, type Market, type CryptoMarketParams } from "./index.js";
import { ProviderRateLimiter, sharedProviderRateLimiter } from "./rateLimiter.js";

const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price";

interface BinanceTickerResponse {
  symbol: string;
  price: string;
}

interface BinanceAdapterOptions extends FetchWithRetryOptions {
  rateLimiter?: ProviderRateLimiter;
}

/**
 * Resolves crypto markets from Binance's public ticker price endpoint.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 */
export class BinanceAdapter implements DataAdapter {
  readonly id = "binance";
  private readonly responseCache: AdapterResponseCache<AdapterOutcome>;

  private readonly fetchOptions: FetchWithRetryOptions;
  private readonly rateLimiter: ProviderRateLimiter;

  constructor(options: BinanceAdapterOptions = {}) {
    const { rateLimiter, ...fetchOptions } = options;
    this.fetchOptions = fetchOptions;
    this.rateLimiter = rateLimiter ?? sharedProviderRateLimiter;
    this.responseCache = new AdapterResponseCache(fetchOptions.cacheTtlMs);
  }

  supports(market: Market): boolean {
    return market.category === "crypto" && isCryptoMarketParams(market.params);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isCryptoMarketParams(market.params)) {
      throw new Error(`BinanceAdapter cannot resolve market ${market.id}: missing/invalid crypto params`);
    }

    const { symbol, comparator, threshold } = market.params as CryptoMarketParams;

    return this.responseCache.getOrSet(marketCacheKey(market), async () => {
      const url = `${BINANCE_TICKER_URL}?symbol=${encodeURIComponent(symbol)}`;
      
      await this.rateLimiter.acquire(this.id);
      const response = await fetchWithRetry(url, { method: "GET" }, this.fetchOptions);
      const body = (await response.json()) as BinanceTickerResponse;

      const price = Number(body.price);
      if (!Number.isFinite(price)) {
        throw new Error(`BinanceAdapter received a non-numeric price for ${symbol}: ${String(body.price)}`);
      }

      const outcome = comparator === "gte" ? price >= threshold : price <= threshold;
      return { outcome, confidence: 1, raw: body };
    });
  }
}
