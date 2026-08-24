import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { type AdapterOutcome, type DataAdapter, isCryptoMarketParams, type Market } from "./index.js";
import { probeHttp } from "./health.js";

const COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";

interface CoinGeckoPriceResponse {
  [id: string]: {
    usd: number;
    usd_market_cap?: number;
    usd_24h_vol?: number;
  };
}

export interface CoinGeckoAdapterOptions extends FetchWithRetryOptions {
  /** CoinGecko API key (optional for free tier, required for higher rate limits) */
  apiKey?: string;
  /** Whether to use market cap instead of price for resolution. Defaults to false. */
  useMarketCap?: boolean;
}

/**
 * Resolves crypto markets from CoinGecko's price/market-cap API.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 * 
 * Note: CoinGecko uses coin IDs (e.g., "bitcoin", "ethereum") rather than trading symbols.
 * The `symbol` in market.params should be the CoinGecko coin ID.
 */
export class CoinGeckoAdapter implements DataAdapter {
  readonly id = "coingecko";

  constructor(private readonly options: CoinGeckoAdapterOptions = {}) {}

  supports(market: Market): boolean {
    return market.category === "crypto" && isCryptoMarketParams(market.params);
  }

  checkHealth() {
    const headers: Record<string, string> = {};
    if (this.options.apiKey) headers["x-cg-demo-api-key"] = this.options.apiKey;
    return probeHttp("https://api.coingecko.com/api/v3/ping", { method: "GET", headers }, this.options);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isCryptoMarketParams(market.params)) {
      throw new Error(`CoinGeckoAdapter cannot resolve market ${market.id}: missing/invalid crypto params`);
    }
    const { symbol, comparator, threshold } = market.params;
    const useMarketCap = this.options.useMarketCap ?? false;

    const queryParams = new URLSearchParams({
      ids: symbol,
      vs_currencies: "usd",
      include_market_cap: useMarketCap ? "true" : "false",
    });

    const url = `${COINGECKO_PRICE_URL}?${queryParams.toString()}`;
    
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    
    if (this.options.apiKey) {
      headers["x-cg-demo-api-key"] = this.options.apiKey;
    }

    const response = await fetchWithRetry(
      url,
      { method: "GET", headers },
      this.options,
    );
    
    const body = (await response.json()) as CoinGeckoPriceResponse;

    const coinData = body[symbol];
    if (!coinData) {
      throw new Error(`CoinGeckoAdapter received no data for symbol ${symbol}`);
    }

    const value = useMarketCap ? coinData.usd_market_cap : coinData.usd;
    
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`CoinGeckoAdapter received invalid ${useMarketCap ? "market cap" : "price"} for ${symbol}: ${String(value)}`);
    }

    const outcome = comparator === "gte" ? value >= threshold : value <= threshold;

    return { outcome, confidence: 1, raw: body };
  }
}
