import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { AdapterResponseCache, marketCacheKey } from "./responseCache.js";
import { type AdapterOutcome, type DataAdapter, isCryptoMarketParams, type Market } from "./index.js";
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

const CMC_QUOTES_URL = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest";

/**
 * CoinMarketCap stamps each quote twice: `last_updated_timestamp` (epoch
 * seconds) and `last_updated` (ISO-8601). The epoch form is preferred because
 * it does not depend on the parser agreeing about a date string, and
 * `last_updated` is kept as a fallback.
 */
const TIMESTAMP_KEYS = ["last_updated_timestamp", "last_updated"] as const;

interface CoinMarketCapQuote {
  price: number;
  last_updated_timestamp?: number;
  last_updated?: string;
}

interface CoinMarketCapResponse {
  data: Record<string, Array<{ quote: Record<string, CoinMarketCapQuote> }>>;
}

export interface CoinMarketCapAdapterOptions extends FetchWithRetryOptions {
  apiKey: string;
  /** Quote currency to price against, defaults to "USD". */
  convert?: string;
  /** Overrides for the freshness bounds applied to each quote. */
  freshness?: Partial<FreshnessPolicy>;
  /** Environment the freshness bounds are read from. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolves crypto markets from CoinMarketCap as a price fallback to Binance.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 *
 * Freshness (issue #744): this is a *fallback* adapter, so the default bounds
 * are the same as the primary's. A fallback that silently served a cached
 * price during a primary outage would be the worst case of the failure this
 * check exists to catch — it would fill the gap precisely when the primary
 * went down.
 */
export class CoinMarketCapAdapter implements DataAdapter {
  readonly id = "coinmarketcap";
  private readonly responseCache: AdapterResponseCache<AdapterOutcome>;
  private readonly freshness: FreshnessPolicy;

  constructor(private readonly options: CoinMarketCapAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("CoinMarketCapAdapter requires an apiKey");
    }
    this.responseCache = new AdapterResponseCache(options.cacheTtlMs);
    this.freshness = freshnessPolicyFromEnv("ORACLE_COINMARKETCAP", options.env, options.freshness);
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

      const quote = body.data?.[symbol]?.[0]?.quote?.[convert];
      const price = quote?.price;
      if (typeof price !== "number" || !Number.isFinite(price)) {
        throw new Error(`CoinMarketCapAdapter received no usable ${convert} price for ${symbol}`);
      }

      const now = Date.now();
      const observedAtMs = extractTimestampMs(quote, TIMESTAMP_KEYS, now);
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
