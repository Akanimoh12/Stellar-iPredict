import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { AdapterResponseCache, marketCacheKey } from "./responseCache.js";
import { type AdapterOutcome, type DataAdapter, isCryptoMarketParams, type Market } from "./index.js";
import { probeHttp } from "./health.js";

const CMC_QUOTES_URL = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest";

interface CoinMarketCapResponse {
  data: Record<string, Array<{ quote: Record<string, { price: number }> }>>;
}

export interface CoinMarketCapAdapterOptions extends FetchWithRetryOptions {
  apiKey: string;
  /** Quote currency to price against, defaults to "USD". */
  convert?: string;
}

/**
 * Resolves crypto markets from CoinMarketCap as a price fallback to Binance.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 */
export class CoinMarketCapAdapter implements DataAdapter {
  readonly id = "coinmarketcap";
  private readonly responseCache: AdapterResponseCache<AdapterOutcome>;

  constructor(private readonly options: CoinMarketCapAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("CoinMarketCapAdapter requires an apiKey");
    }
    this.responseCache = new AdapterResponseCache(options.cacheTtlMs);
  }

  supports(market: Market): boolean {
    return market.category === "crypto" && isCryptoMarketParams(market.params);
  }

  checkHealth() {
    return probeHttp("https://pro-api.coinmarketcap.com/v1/key/info", {
      method: "GET", headers: { "X-CMC_PRO_API_KEY": this.options.apiKey, Accept: "application/json" },
    }, this.options);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isCryptoMarketParams(market.params)) {
      throw new Error(`CoinMarketCapAdapter cannot resolve market ${market.id}: missing/invalid crypto params`);
    }
    const params = market.params;

    return this.responseCache.getOrSet(marketCacheKey(market), async () => {
      const { symbol, comparator, threshold } = params;
      const convert = this.options.convert ?? "USD";
      const url = `${CMC_QUOTES_URL}?symbol=${encodeURIComponent(symbol)}&convert=${encodeURIComponent(convert)}`;
      const response = await fetchWithRetry(
        url,
        { method: "GET", headers: { "X-CMC_PRO_API_KEY": this.options.apiKey, Accept: "application/json" } },
        this.options,
      );
      const body = (await response.json()) as CoinMarketCapResponse;

      const price = body.data?.[symbol]?.[0]?.quote?.[convert]?.price;
      if (typeof price !== "number" || !Number.isFinite(price)) {
        throw new Error(`CoinMarketCapAdapter received no usable ${convert} price for ${symbol}`);
      }

      const outcome = comparator === "gte" ? price >= threshold : price <= threshold;
      return { outcome, confidence: 1, raw: body };
    });
  }
}
