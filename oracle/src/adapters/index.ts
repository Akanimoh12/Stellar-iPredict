export { resolveMarket, DEFAULT_CATEGORY_CONFIG, DEFAULT_OPTIONS } from "./resolve.js";
export type { ResolutionResult, SourceResult, ResolutionStatus, ResolveOptions, CategoryResolutionConfig } from "./resolve.js";
export {
  ADAPTER_API_KEY_ENV,
  loadAdapterApiKeys,
  requireAdapterApiKey,
} from "./config.js";
export type { AdapterApiKeyName, AdapterApiKeys, AdapterEnvironment } from "./config.js";

export type MarketCategory = "crypto" | "sports" | "politics" | "science";

/** Comparator applied between the fetched value and `params.threshold` for threshold-style markets. */
export type ThresholdComparator = "gte" | "lte";

export interface CryptoMarketParams {
  /** Exchange/provider-specific symbol, e.g. "BTCUSDT" (Binance) or "BTC" (CoinMarketCap). */
  symbol: string;
  comparator: ThresholdComparator;
  threshold: number;
}

export interface PoliticsMarketParams {
  /** Market identifier or slug for the politics data source. */
  marketId: string;
  /** Expected outcome to check against (e.g., "YES", "NO", or specific candidate/event). */
  expectedOutcome: string;
}

export interface Market {
  id: string;
  category: MarketCategory;
  /** Category-specific query parameters an adapter maps to a provider query. */
  params: Record<string, unknown>;
}

export interface AdapterOutcome {
  outcome: boolean;
  /** 0-1 confidence in the outcome, for weighting/aggregation upstream. */
  confidence: number;
  /** Raw provider payload, kept for audit/dispute review. */
  raw: unknown;
  /** Provider reports that the event cannot settle normally. */
  cancellation?: {
    reason: "postponed" | "cancelled";
    message?: string;
  };
}

export interface AdapterHealth {
  available: boolean;
  checkedAt: string;
  latencyMs: number;
  error?: string;
}

export interface DataAdapter {
  readonly id: string;
  /** Whether this adapter can resolve the given market (category + required params present). */
  supports(market: Market): boolean;
  fetchOutcome(market: Market): Promise<AdapterOutcome>;
  /** A quota-light provider availability probe, when supported. */
  checkHealth?(): Promise<AdapterHealth>;
}

/** Type guard shared by crypto adapters (Binance, CoinMarketCap, ...) to validate `market.params`. */
export function isCryptoMarketParams(
  params: Record<string, unknown>,
): params is Record<string, unknown> & CryptoMarketParams {
  return (
    typeof params.symbol === "string" &&
    params.symbol.length > 0 &&
    (params.comparator === "gte" || params.comparator === "lte") &&
    typeof params.threshold === "number" &&
    Number.isFinite(params.threshold)
  );
}

/** Type guard shared by politics adapters (Polymarket, Reuters, ...) to validate `market.params`. */
export function isPoliticsMarketParams(
  params: Record<string, unknown>,
): params is Record<string, unknown> & PoliticsMarketParams {
  return (
    typeof params.marketId === "string" &&
    params.marketId.length > 0 &&
    typeof params.expectedOutcome === "string" &&
    params.expectedOutcome.length > 0
  );
}

/**
 * Selects data adapters for a market by category. Adapters are tried in
 * registration order, so register primary sources before fallbacks (see
 * the source priority table in docs/ORACLE_AND_BACKEND.md).
 */
export class AdapterRegistry {
  private readonly adapters: DataAdapter[] = [];

  register(adapter: DataAdapter): void {
    this.adapters.push(adapter);
  }

  /** Adapters that support this market, in registration order. */
  adaptersFor(market: Market): DataAdapter[] {
    return this.adapters.filter((adapter) => adapter.supports(market));
  }

  getById(id: string): DataAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  list(): readonly DataAdapter[] {
    return this.adapters;
  }
}

export { checkAdapterHealth, checkAdaptersHealth } from "./health.js";
export type { AdapterHealthCheckOptions, AdapterHealthReport } from "./health.js";
export { InMemoryReviewQueue } from "./reviewQueue.js";
export type { ManualReviewItem, ManualReviewQueue, ReviewReason } from "./reviewQueue.js";
export { FixtureReplayAdapter, RecordingAdapter } from "./fixtures.js";
export type { AdapterFixture, FixtureSink } from "./fixtures.js";
