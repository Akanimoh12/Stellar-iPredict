export { resolveMarket } from "./resolve.js";
export type { ResolutionResult, SourceResult, ResolutionStatus, ResolveOptions, CategoryResolutionConfig } from "./resolve.js";

export type MarketCategory = "crypto" | "sports" | "politics" | "science";

/** Comparator applied between the fetched value and `params.threshold` for threshold-style markets. */
export type ThresholdComparator = "gte" | "lte";

export interface CryptoMarketParams {
  /** Exchange/provider-specific symbol, e.g. "BTCUSDT" (Binance) or "BTC" (CoinMarketCap). */
  symbol: string;
  comparator: ThresholdComparator;
  threshold: number;
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
}

export interface DataAdapter {
  readonly id: string;
  /** Whether this adapter can resolve the given market (category + required params present). */
  supports(market: Market): boolean;
  fetchOutcome(market: Market): Promise<AdapterOutcome>;
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
