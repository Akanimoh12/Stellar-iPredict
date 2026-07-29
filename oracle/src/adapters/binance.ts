import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { type AdapterOutcome, type DataAdapter, isCryptoMarketParams, type Market } from "./index.js";

const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price";

interface BinanceTickerResponse {
  symbol: string;
  price: string;
}

/**
 * Resolves crypto markets from Binance's public ticker price endpoint.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 */
export class BinanceAdapter implements DataAdapter {
  readonly id = "binance";

  constructor(private readonly options: FetchWithRetryOptions = {}) {}

  supports(market: Market): boolean {
    return market.category === "crypto" && isCryptoMarketParams(market.params);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isCryptoMarketParams(market.params)) {
      throw new Error(`BinanceAdapter cannot resolve market ${market.id}: missing/invalid crypto params`);
    }
    const { symbol, comparator, threshold } = market.params;

    const url = `${BINANCE_TICKER_URL}?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetchWithRetry(url, { method: "GET" }, this.options);
    const body = (await response.json()) as BinanceTickerResponse;

    const price = Number(body.price);
    if (!Number.isFinite(price)) {
      throw new Error(`BinanceAdapter received a non-numeric price for ${symbol}: ${String(body.price)}`);
    }

    const outcome = comparator === "gte" ? price >= threshold : price <= threshold;

    return { outcome, confidence: 1, raw: body };
  }
}
