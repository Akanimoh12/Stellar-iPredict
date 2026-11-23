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

const COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const COINGECKO_MARKET_CHART_RANGE = "https://api.coingecko.com/api/v3/coins"; // /{id}/market_chart/range

interface CoinGeckoPriceResponse {
  [id: string]: {
    usd: number;
    usd_market_cap?: number;
    usd_24h_vol?: number;
    /** Epoch seconds the quote was produced. */
    last_updated_at?: number;
  };
}

/** Half-width of the historical lookup window, in seconds. */
const HISTORICAL_WINDOW_SECONDS = 30;

export interface CoinGeckoAdapterOptions extends FetchWithRetryOptions {
  /** CoinGecko API key (optional for free tier, required for higher rate limits) */
  apiKey?: string;
  /** Whether to use market cap instead of price for resolution. Defaults to false. */
  useMarketCap?: boolean;
  /** Rate limiter instance for coordinating request quota. */
  rateLimiter?: ProviderRateLimiter;
  /** Overrides for the freshness bounds applied to each quote. */
  freshness?: Partial<FreshnessPolicy>;
  /** Environment the freshness bounds are read from. Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolves crypto markets from CoinGecko's price/market-cap API.
 * `market.params` must satisfy `CryptoMarketParams` (symbol/comparator/threshold).
 *
 * Note: CoinGecko uses coin IDs (e.g., "bitcoin", "ethereum") rather than trading symbols.
 * The `symbol` in market.params should be the CoinGecko coin ID.
 *
 * Freshness (issue #744) is checked against the *instant the market asks
 * about*, not the wall clock. A market resolving on yesterday's close is
 * supposed to see yesterday's price, so comparing that quote to `Date.now()`
 * would reject nearly every historical resolution. For a live quote the
 * reference instant is now, as for any other provider.
 */
export class CoinGeckoAdapter implements DataAdapter {
  readonly id = "coingecko";
  private readonly responseCache: AdapterResponseCache<{ value: number; raw: unknown; observedAtMs?: number; referenceNow: number }>;
  private readonly rateLimiter: ProviderRateLimiter;
  private readonly freshness: FreshnessPolicy;

  constructor(private readonly options: CoinGeckoAdapterOptions = {}) {
    const { rateLimiter, env, freshness } = options;
    this.rateLimiter = rateLimiter ?? sharedProviderRateLimiter;
    this.responseCache = new AdapterResponseCache(options.cacheTtlMs);
    this.freshness = freshnessPolicyFromEnv("ORACLE_COINGECKO", env, freshness);
  }

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

    const cached = await this.responseCache.getOrSet(marketCacheKey(market), async () => {
      await this.rateLimiter.acquire(this.id);
      const at = typeof (market.params as any).at === "number" ? Number((market.params as any).at) : undefined;
      let value: number | undefined;
      let raw: unknown;
      let observedAtMs: number | undefined;
      let referenceNow: number = Date.now();

      if (typeof at === "number" && Number.isFinite(at) && at > 0) {
        const from = Math.max(0, Math.floor(at) - HISTORICAL_WINDOW_SECONDS);
        const to = Math.floor(at) + HISTORICAL_WINDOW_SECONDS;
        const url = `${COINGECKO_MARKET_CHART_RANGE}/${encodeURIComponent(symbol)}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;

        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.options.apiKey) headers["x-cg-demo-api-key"] = this.options.apiKey;

        const response = await fetchWithRetry(url, { method: "GET", headers }, this.options);
        const body = await response.json();
        raw = body;

        const prices: unknown = (body as any).prices;
        if (Array.isArray(prices) && prices.length > 0) {
          const atMs = at * 1000;
          referenceNow = atMs;
          let best: { ts: number; price: number } | null = null;
          for (const item of prices) {
            if (!Array.isArray(item) || item.length < 2) continue;
            const ts = Number(item[0]);
            const p = Number(item[1]);
            if (!Number.isFinite(ts) || !Number.isFinite(p)) continue;
            const cand = { ts, price: p };
            if (!best || Math.abs(cand.ts - atMs) < Math.abs(best.ts - atMs)) best = cand;
          }
          if (best) {
            value = best.price;
            observedAtMs = best.ts;
          }
        }
      }

      if (value === undefined) {
        const queryParams = new URLSearchParams({
          ids: symbol,
          vs_currencies: "usd",
          include_market_cap: useMarketCap ? "true" : "false",
        });

        const url = `${COINGECKO_PRICE_URL}?${queryParams.toString()}`;
        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.options.apiKey) {
          headers["x-cg-demo-api-key"] = this.options.apiKey;
        }

        const response = await fetchWithRetry(url, { method: "GET", headers }, this.options);
        const body = (await response.json()) as CoinGeckoPriceResponse;
        raw = body;

        const coinData = (body as CoinGeckoPriceResponse)[symbol];
        if (!coinData) {
          throw new Error(`CoinGeckoAdapter received no data for symbol ${symbol}`);
        }

        value = useMarketCap ? coinData.usd_market_cap : coinData.usd;
        observedAtMs = extractTimestampMs(coinData, ["last_updated_at"], referenceNow);
      }

      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`CoinGeckoAdapter received invalid ${useMarketCap ? "market cap" : "price"} for ${symbol}: ${String(value)}`);
      }

      return { value, raw, observedAtMs, referenceNow };
    });

    const freshness = assessQuote(cached.observedAtMs, this.freshness, cached.referenceNow);
    recordQuoteStatus(this.id, freshness.status, Date.now());

    if (freshness.status === "expired") {
      throw new StaleQuoteError(this.id, {
        ageMs: freshness.ageMs ?? 0,
        maxAgeMs: this.freshness.maxAgeMs,
        observedAtMs: freshness.observedAtMs,
      });
    }

    const { outcome, confidence } = normalizeCryptoQuote({
      price: cached.value,
      threshold,
      comparator,
      observedAtMs: cached.observedAtMs,
      freshness: this.freshness,
      now: cached.referenceNow,
    });

    return {
      outcome,
      confidence,
      raw: cached.raw,
      freshness: {
        status: freshness.status,
        ageMs: freshness.ageMs,
        observedAtMs: freshness.observedAtMs,
        maxAgeMs: this.freshness.maxAgeMs,
      },
    };
  }
}
